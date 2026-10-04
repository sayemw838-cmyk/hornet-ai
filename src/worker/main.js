import { pathToFileURL } from "node:url";
import { SupabaseRest } from "../adapters/supabase-rest.js";
import { createModelProviderFromEnv } from "../adapters/model-provider.js";
import { createMcpTools } from "../adapters/mcp-tools.js";
import { loadSecretResolver } from "../adapters/secret-resolver.js";
import { executeOperator } from "../core/operator.js";
import { HornetError, safeErrorCode } from "../core/errors.js";
import { containsSecretLikeValue, sanitizeForEvidence } from "../core/permissions.js";
import { nextCronOccurrenceUtc } from "../core/schedule.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function first(store, table, query) {
  const rows = await store.serviceSelect(table, query);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function loadWorkspaceContext(store, job) {
  const run = await first(store, "automation_runs", new URLSearchParams({ select: "id,workspace_id,automation_id,requested_by,status,input,result,error_code", id: `eq.${job.run_id}`, workspace_id: `eq.${job.workspace_id}`, limit: "1" }));
  if (!run) throw new HornetError("run_not_found", "The claimed run does not exist in its claimed workspace.", { status: 404 });
  const automation = await first(store, "automations", new URLSearchParams({ select: "id,workspace_id,agent_id,name,description,definition,trigger_type,enabled", id: `eq.${run.automation_id}`, workspace_id: `eq.${run.workspace_id}`, limit: "1" }));
  if (!automation || !automation.enabled) throw new HornetError("automation_disabled", "The queued automation is missing or disabled.", { status: 409 });
  const agent = automation.agent_id ? await first(store, "agents", new URLSearchParams({ select: "id,workspace_id,name,instructions,config,enabled", id: `eq.${automation.agent_id}`, workspace_id: `eq.${run.workspace_id}`, limit: "1" })) : null;
  if (!agent?.enabled) throw new HornetError("agent_disabled", "The automation has no enabled workspace agent.", { status: 409 });
  const agentSkills = await store.serviceSelect("agent_skills", new URLSearchParams({ select: "skill_id", agent_id: `eq.${agent.id}`, workspace_id: `eq.${run.workspace_id}`, limit: "50" }));
  const skillIds = (Array.isArray(agentSkills) ? agentSkills : []).map((row) => row.skill_id).filter(Boolean);
  let skills = [];
  if (skillIds.length) {
    skills = await store.serviceSelect("skills", new URLSearchParams({ select: "id,workspace_id,name,description,instructions,manifest,status,version", workspace_id: `eq.${run.workspace_id}`, status: "eq.published", id: `in.(${skillIds.join(",")})`, limit: "50" }));
  }
  const mcpConnections = await store.serviceSelect("mcp_connections", new URLSearchParams({ select: "id,workspace_id,name,endpoint_url,transport,allowed_hosts,allowed_tools,config,secret_ref,status", workspace_id: `eq.${run.workspace_id}`, status: "eq.active", limit: "100" }));
  return { run, automation, agent, skills: Array.isArray(skills) ? skills : [], mcpConnections: Array.isArray(mcpConnections) ? mcpConnections : [] };
}

async function loadToolRegistry(env, secretResolver) {
  if (!env.HORNET_TOOLS_MODULE) return {};
  const moduleUrl = env.HORNET_TOOLS_MODULE.startsWith("file:") ? env.HORNET_TOOLS_MODULE : pathToFileURL(env.HORNET_TOOLS_MODULE).href;
  const adapter = await import(moduleUrl);
  if (typeof adapter.createTools !== "function") throw new Error("Tool module must export createTools().");
  const tools = await adapter.createTools({ secretResolver });
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) throw new Error("Tool module returned an invalid registry.");
  for (const [name, tool] of Object.entries(tools)) if (tool.name !== name) throw new Error("Tool registry keys must match trusted tool names.");
  return tools;
}

async function approvedActionForRun(store, workspaceId, runId) {
  const query = new URLSearchParams({ select: "id,payload", workspace_id: `eq.${workspaceId}`, run_id: `eq.${runId}`, status: "eq.approved", order: "reviewed_at.desc", limit: "1" });
  return first(store, "approvals", query);
}

async function planForRun(store, workspaceId, runId) {
  const query = new URLSearchParams({ select: "evidence", workspace_id: `eq.${workspaceId}`, run_id: `eq.${runId}`, event_type: "eq.operator.plan_created", order: "id.asc", limit: "1" });
  const event = await first(store, "automation_run_events", query);
  return event?.evidence?.plan || null;
}

async function verifiedIndicesForRun(store, workspaceId, runId) {
  const query = new URLSearchParams({ select: "step_index", workspace_id: `eq.${workspaceId}`, run_id: `eq.${runId}`, event_type: "eq.operator.step_verified", limit: "50" });
  const rows = await store.serviceSelect("automation_run_events", query);
  return (Array.isArray(rows) ? rows : []).map((row) => Number(row.step_index)).filter(Number.isInteger);
}

export async function processClaimedJob(job, { store, workerId, modelProvider, tools, secretResolver = { resolve: async () => null }, leaseSeconds = 60 }) {
  const aborter = new AbortController();
  let leaseLost = false;
  const context = await loadWorkspaceContext(store, job);
  if (["cancelled", "succeeded", "failed"].includes(context.run.status)) return { status: context.run.status, skipped: true };
  const patchRun = (status, extra = {}) => store.servicePatch("automation_runs", new URLSearchParams({ id: `eq.${context.run.id}`, workspace_id: `eq.${context.run.workspace_id}` }), { status, ...extra, updated_at: new Date().toISOString() });
  await patchRun("running", { started_at: context.run.started_at || new Date().toISOString() });
  await store.recordEvent({ workspaceId: context.run.workspace_id, runId: context.run.id, type: "worker.started", message: "Worker claimed the durable job.", evidence: { attempt: job.attempts, worker_id: workerId } });

  const heartbeatMs = Math.max(5000, Math.floor(leaseSeconds * 1000 / 3));
  const heartbeat = setInterval(async () => {
    try {
      const [renewed, latest] = await Promise.all([
        store.renewLease(job.id, workerId, leaseSeconds),
        first(store, "automation_runs", new URLSearchParams({ select: "status", id: `eq.${context.run.id}`, workspace_id: `eq.${context.run.workspace_id}`, limit: "1" })),
      ]);
      if (!(renewed === true || renewed === "true") || latest?.status === "cancelled") {
        leaseLost = true;
        aborter.abort(new Error(latest?.status === "cancelled" ? "cancelled" : "lease_lost"));
      }
    } catch {
      // No secret, request payload, or provider error detail is logged. The next heartbeat can recover.
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  try {
    if (containsSecretLikeValue({ input: context.run.input, automation: context.automation.definition, agent: context.agent.config, skills: context.skills.map((skill) => ({ instructions: skill.instructions, manifest: skill.manifest })), connections: context.mcpConnections.map((connection) => connection.config) })) {
      throw new HornetError("secret_in_persisted_config", "Credential-shaped data was found in ordinary workspace configuration; execution is blocked until secrets are moved to a secret store.", { status: 422 });
    }
    const mcpTools = await createMcpTools({ connections: context.mcpConnections, resolveSecret: (ref) => secretResolver.resolve(ref) });
    const combinedTools = { ...tools };
    for (const [name, tool] of Object.entries(mcpTools)) {
      if (combinedTools[name]) throw new HornetError("tool_name_collision", "Two trusted tool adapters have the same public name.", { status: 500 });
      combinedTools[name] = tool;
    }
    const io = {
      emit: (event) => store.recordEvent(event),
      getPlan: (runId) => planForRun(store, context.run.workspace_id, runId),
      savePlan: (runId, workspaceId, plan) => store.recordEvent({ workspaceId, runId, type: "operator.plan_created", message: "Bounded execution plan recorded.", evidence: { plan: sanitizeForEvidence(plan) } }),
      requestApproval: async (approval) => {
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        const rows = await store.serviceInsert("approvals", [{ workspace_id: approval.workspaceId, run_id: approval.runId, requested_by: context.run.requested_by, action_type: approval.actionType, action_summary: approval.actionSummary, payload: sanitizeForEvidence(approval.payload), status: "pending", expires_at: expires }], { returning: true });
        // Supabase REST with return=representation returns rows; if the API is configured for minimal return, read back the unique pending approval.
        const created = Array.isArray(rows) ? rows[0] : rows;
        if (created?.id) return created;
        const query = new URLSearchParams({ select: "id,payload", workspace_id: `eq.${approval.workspaceId}`, run_id: `eq.${approval.runId}`, status: "eq.pending", action_type: `eq.${approval.actionType}`, order: "created_at.desc", limit: "1" });
        const pending = await first(store, "approvals", query);
        if (!pending?.id) throw new HornetError("approval_creation_failed", "Approval could not be durably recorded.", { status: 503, retryable: true });
        return pending;
      },
      pauseForApproval: (approvalId) => store.pauseJob(job.id, workerId, approvalId),
    };
    const approved = await approvedActionForRun(store, context.run.workspace_id, context.run.id);
    const runtime = modelProvider?.startRun();
    const result = await executeOperator({
      run: context.run,
      automation: context.automation,
      agent: context.agent,
      skills: context.skills,
      tools: combinedTools,
      model: runtime,
      io,
      signal: aborter.signal,
      approvedAction: approved,
      previouslyVerified: await verifiedIndicesForRun(store, context.run.workspace_id, context.run.id),
    });
    if (leaseLost || aborter.signal.aborted) throw new HornetError("lease_lost", "Worker lease was cancelled or lost.", { status: 409 });
    if (result.status === "waiting_approval") return result;
    const finalResult = { ...result, ...(runtime?.usage ? { model_usage: runtime.usage() } : {}) };
    const finished = await store.finishJob(job.id, workerId, sanitizeForEvidence(finalResult));
    if (!(finished === true || finished === "true")) throw new HornetError("lease_lost", "Worker lease expired before completion could be committed.", { status: 409, retryable: true });
    return finalResult;
  } catch (error) {
    if (error?.code === "cancelled" || leaseLost || aborter.signal.aborted) return { status: "cancelled_or_lease_lost" };
    const retryable = Boolean(error?.retryable);
    const attempt = Math.max(1, Number(job.attempts) || 1);
    const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempt - 1, 8)));
    await store.failJob(job.id, workerId, safeErrorCode(error), delaySeconds, retryable);
    await store.recordEvent({ workspaceId: context.run.workspace_id, runId: context.run.id, type: "worker.attempt_failed", message: retryable ? "Worker attempt failed and was scheduled for bounded retry." : "Worker attempt failed without retry.", evidence: { error_code: safeErrorCode(error), retryable, attempt } }).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function enqueueDueSchedules(store, now = new Date()) {
  const query = new URLSearchParams({ select: "id,workspace_id,definition,schedule_cron,timezone,next_run_at", trigger_type: "eq.schedule", enabled: "eq.true", next_run_at: `lte.${now.toISOString()}`, order: "next_run_at.asc", limit: "25" });
  const due = await store.serviceSelect("automations", query);
  let enqueued = 0;
  for (const automation of Array.isArray(due) ? due : []) {
    if (automation.timezone !== "UTC") continue;
    try {
      const dueAt = new Date(automation.next_run_at);
      const nextAt = nextCronOccurrenceUtc(automation.schedule_cron, dueAt);
      const input = automation.definition?.input_template || {};
      if (containsSecretLikeValue(input)) continue;
      await store.enqueueScheduled(automation.id, dueAt.toISOString(), nextAt.toISOString(), input);
      enqueued += 1;
    } catch {
      // Invalid schedule rows remain visible for operator correction; never log their definitions.
    }
  }
  return enqueued;
}

export async function workerTick({ store, workerId, modelProvider, tools, secretResolver, maxClaim = 5, leaseSeconds = 60 }) {
  const claimed = await store.claimJobs(workerId, maxClaim);
  const jobs = Array.isArray(claimed) ? claimed : [];
  const outcomes = [];
  for (const job of jobs) {
    try {
      outcomes.push(await processClaimedJob(job, { store, workerId, modelProvider, tools, secretResolver, leaseSeconds }));
    } catch (error) {
      outcomes.push({ status: "attempt_failed", error_code: safeErrorCode(error) });
    }
  }
  return outcomes;
}

export async function startWorker(env = process.env) {
  const store = new SupabaseRest({ url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  const modelProvider = createModelProviderFromEnv(env);
  const secretResolver = await loadSecretResolver(env.HORNET_SECRET_RESOLVER_MODULE || "");
  const tools = await loadToolRegistry(env, secretResolver);
  const workerId = env.HORNET_WORKER_ID || `hornet-${process.pid}`;
  const pollMs = Math.max(500, Number(env.HORNET_POLL_MS || 3000));
  const scheduleMs = Math.max(5000, Number(env.HORNET_SCHEDULER_POLL_MS || 30000));
  const maxClaim = Math.max(1, Math.min(50, Number(env.HORNET_MAX_CLAIM || 5)));
  const leaseSeconds = Math.max(10, Math.min(300, Number(env.HORNET_LEASE_SECONDS || 60)));
  let lastSchedule = 0;
  console.info("hornet_worker_started", { workerId, modelProvider: modelProvider?.provider || "disabled", tools: Object.keys(tools).length });
  while (true) {
    try {
      if (Date.now() - lastSchedule >= scheduleMs) {
        const enqueued = await enqueueDueSchedules(store);
        if (enqueued) console.info("hornet_schedules_enqueued", { count: enqueued });
        lastSchedule = Date.now();
      }
      await workerTick({ store, workerId, modelProvider, tools, secretResolver, maxClaim, leaseSeconds });
    } catch (error) {
      console.error("hornet_worker_tick_failed", { code: safeErrorCode(error) });
    }
    await sleep(pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startWorker().catch((error) => {
  console.error("hornet_worker_start_failed", { code: safeErrorCode(error) });
  process.exitCode = 1;
});
