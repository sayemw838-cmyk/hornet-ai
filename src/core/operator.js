import { HornetError } from "./errors.js";
import { matchSkills } from "./skill-match.js";
import { actionDigest, assertToolAllowed, containsSecretLikeValue, sanitizeForEvidence } from "./permissions.js";

function normalizePlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length < 1 || steps.length > 20) throw new HornetError("invalid_plan", "The agent did not produce a bounded, executable plan.", { status: 422 });
  return {
    expectedOutcome: String(plan.expected_outcome || "").slice(0, 1000),
    steps: steps.map((step, index) => {
      if (!step || typeof step !== "object" || typeof step.tool !== "string" || !step.tool.trim() || !step.args || typeof step.args !== "object" || Array.isArray(step.args)) {
        throw new HornetError("invalid_plan", `Plan step ${index + 1} is malformed.`, { status: 422 });
      }
      if (containsSecretLikeValue(step.args)) throw new HornetError("secret_in_tool_arguments", `Plan step ${index + 1} contains credential-shaped data; use a secret reference, not a value.`, { status: 422 });
      return { title: String(step.title || `Step ${index + 1}`).slice(0, 240), tool: step.tool, args: step.args, verification: String(step.verification || "").slice(0, 1000) };
    }),
  };
}

export async function executeOperator({ run, automation, agent, skills = [], tools = {}, model, io, signal, approvedAction = null, previouslyVerified = [] }) {
  if (!model?.plan || !io?.emit || !io?.savePlan || !io?.getPlan || !io?.requestApproval || !io?.pauseForApproval) {
    throw new HornetError("runtime_not_configured", "The agent runtime or durable progress adapter is not configured.", { status: 503 });
  }
  const workspaceId = run.workspace_id;
  const objective = String(automation?.definition?.objective || automation?.description || automation?.name || "").trim();
  if (!objective) throw new HornetError("objective_missing", "The automation has no execution objective.", { status: 422 });
  const selectedSkills = matchSkills(skills, `${objective}\n${String(run.input?.goal || "")}\n${JSON.stringify(run.input || {})}`, 4);
  const allowedTools = Array.isArray(automation?.definition?.tool_allowlist) ? automation.definition.tool_allowlist : [];
  const toolDescriptions = Object.values(tools).filter((tool) => allowedTools.includes(tool.name)).map(({ name, capability, description, inputSchema }) => ({ name, capability, description: String(description || "").slice(0, 500), inputSchema: sanitizeForEvidence(inputSchema || {}) }));
  if (!toolDescriptions.length) throw new HornetError("no_tools_allowed", "No tools are enabled by this workspace automation.", { status: 403 });

  let plan = await io.getPlan(run.id);
  if (!plan) {
    await io.emit({ workspaceId, runId: run.id, type: "operator.planning", message: "Planning the worker objective and matching workspace skills.", evidence: { matched_skill_ids: selectedSkills.map((skill) => skill.id), available_tool_names: toolDescriptions.map((tool) => tool.name) } });
    const proposed = await model.plan({ objective, input: sanitizeForEvidence(run.input || {}), agent: { name: agent?.name, instructions: agent?.instructions }, skills: selectedSkills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, operator_workflow: skill.manifest?.operator_workflow || [] })), tools: toolDescriptions });
    plan = normalizePlan(proposed);
    await io.savePlan(run.id, workspaceId, plan);
  } else {
    plan = normalizePlan(plan);
  }

  const verifiedSet = new Set(previouslyVerified);
  for (let index = 0; index < plan.steps.length; index += 1) {
    if (signal?.aborted) throw new HornetError("cancelled", "Run cancellation was requested.", { status: 409 });
    if (verifiedSet.has(index)) continue;
    const step = plan.steps[index];
    const tool = tools[step.tool];
    if (!tool || typeof tool.execute !== "function") throw new HornetError("tool_unavailable", `A planned tool is not configured: ${step.tool}.`, { status: 422 });
    const connectorAllowlist = tool.connectionId ? (automation?.definition?.connector_tool_allowlists?.[tool.connectionId] || []) : null;
    const authorization = assertToolAllowed(tool, { workspaceAllowlist: allowedTools, connectorAllowlist });
    const digest = actionDigest(step.tool, step.args);
    const isApproved = approvedAction && Number(approvedAction.payload?.step_index) === index;
    if (isApproved && (approvedAction.payload?.action_digest !== digest || approvedAction.payload?.tool !== step.tool)) {
      throw new HornetError("approval_action_mismatch", "The pending action no longer matches the exact approved action; execution was blocked.", { status: 409 });
    }
    if (authorization.requiresApproval && !isApproved) {
      const approval = await io.requestApproval({
        workspaceId,
        runId: run.id,
        actionType: `tool.${step.tool}`,
        actionSummary: step.title,
        payload: { tool: step.tool, args: sanitizeForEvidence(step.args), step_index: index, action_digest: digest, verification: step.verification },
      });
      await io.emit({ workspaceId, runId: run.id, type: "operator.approval_requested", message: `Approval is required before ${step.tool} can run.`, stepIndex: index, evidence: { approval_id: approval.id, tool: step.tool, action_digest: digest } });
      const paused = await io.pauseForApproval(approval.id);
      if (!paused) throw new HornetError("approval_pause_failed", "The job lease could not be safely paused for approval.", { status: 409, retryable: true });
      return { status: "waiting_approval", outcome: "NEEDS_APPROVAL", approval_id: approval.id, evidence: { verified_steps: [...verifiedSet] } };
    }

    await io.emit({ workspaceId, runId: run.id, type: "operator.step_started", message: `Executing plan step ${index + 1}: ${step.title}`, stepIndex: index, evidence: { tool: step.tool, capability: authorization.capability } });
    let observed;
    try {
      observed = await tool.execute(step.args, { run, workspaceId, signal });
    } catch (error) {
      throw new HornetError(error?.code || "tool_execution_failed", "A worker tool failed during execution.", { status: 502, retryable: Boolean(error?.retryable) });
    }
    if (!observed || observed.success !== true) throw new HornetError("tool_execution_failed", `Tool ${step.tool} did not confirm successful execution.`, { status: 502, retryable: Boolean(observed?.retryable) });
    const verification = typeof tool.verify === "function" ? await tool.verify({ args: step.args, result: observed, instruction: step.verification, signal }) : { passed: observed.verified === true, evidence: observed.evidence };
    if (verification?.passed !== true || !String(verification?.evidence || "").trim()) {
      await io.emit({ workspaceId, runId: run.id, type: "operator.step_unverified", message: `The result of ${step.tool} did not meet its verification check.`, stepIndex: index, evidence: { result: sanitizeForEvidence(observed), verification: sanitizeForEvidence(verification) } });
      throw new HornetError("verification_failed", `Tool ${step.tool} returned no sufficient verification evidence.`, { status: 422 });
    }
    const evidence = { tool: step.tool, capability: authorization.capability, verification: sanitizeForEvidence(verification), result: sanitizeForEvidence(observed.evidence ?? observed.result ?? null), action_digest: digest };
    await io.emit({ workspaceId, runId: run.id, type: "operator.step_verified", message: `Verified plan step ${index + 1}: ${step.title}`, stepIndex: index, evidence });
    verifiedSet.add(index);
  }

  if (verifiedSet.size !== plan.steps.length) throw new HornetError("outcome_incomplete", "The agent plan was not fully verified; the run cannot be marked complete.", { status: 422 });
  const result = { outcome: "COMPLETE", summary: plan.expectedOutcome || "All planned steps completed and verified.", verified_steps: [...verifiedSet].sort((a, b) => a - b), evidence_status: "verified" };
  await io.emit({ workspaceId, runId: run.id, type: "operator.outcome_verified", message: "All planned actions have matching successful results and verification evidence.", evidence: result });
  return { status: "succeeded", ...result };
}
