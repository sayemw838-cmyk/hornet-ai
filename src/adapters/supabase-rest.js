import { createHash } from "node:crypto";
import { HornetError } from "../core/errors.js";

export class SupabaseRest {
  constructor({ url, publishableKey, serviceRoleKey, fetchImpl = globalThis.fetch }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.publishableKey = String(publishableKey || "");
    this.serviceRoleKey = String(serviceRoleKey || "");
    this.fetch = fetchImpl;
    if (!this.url || !this.publishableKey || !this.serviceRoleKey) throw new Error("Supabase runtime configuration is incomplete.");
  }

  async request(path, { method = "GET", body, userToken = null, service = false, headers = {} } = {}) {
    const key = service ? this.serviceRoleKey : this.publishableKey;
    const authorization = service ? this.serviceRoleKey : (userToken || this.publishableKey);
    const response = await this.fetch(`${this.url}${path}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${authorization}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      const status = response.status;
      throw new HornetError(status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "supabase_request_failed", "The requested Supabase operation failed.", {
        status: status === 401 ? 401 : status === 403 ? 403 : status === 404 ? 404 : status === 409 ? 409 : status === 429 ? 503 : 502,
        retryable: status === 429 || status >= 500,
      });
    }
    return parsed;
  }

  async authenticateUser(token) {
    if (!token) throw new HornetError("authentication_required", "A valid bearer credential is required.", { status: 401 });
    return this.request("/auth/v1/user", { userToken: token });
  }

  rpc(name, args, options = {}) {
    return this.request(`/rest/v1/rpc/${encodeURIComponent(name)}`, { method: "POST", body: args, ...options });
  }

  async enqueueAsUser(workspaceId, automationId, input, idempotencyKey, userToken) {
    const rows = await this.rpc("enqueue_automation_run", {
      p_workspace_id: workspaceId,
      p_automation_id: automationId,
      p_input: input,
      p_idempotency_key: idempotencyKey,
    }, { userToken });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async enqueueWithApiKey(workspaceId, automationId, input, idempotencyKey, apiKey) {
    const keyDigest = `\\x${createHash("sha256").update(apiKey).digest("hex")}`;
    const rows = await this.rpc("enqueue_automation_run_with_api_key", {
      p_workspace_id: workspaceId,
      p_automation_id: automationId,
      p_input: input,
      p_idempotency_key: idempotencyKey,
      p_key_digest: keyDigest,
    }, { service: true });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async getRunAsUser(workspaceId, runId, userToken) {
    const query = new URLSearchParams({ select: "id,workspace_id,automation_id,status,result,error_code,created_at,started_at,finished_at", id: `eq.${runId}`, workspace_id: `eq.${workspaceId}`, limit: "1" });
    const rows = await this.request(`/rest/v1/automation_runs?${query}`, { userToken });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async userSelect(table, query, userToken) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
    return this.request(`/rest/v1/${encodeURIComponent(table)}?${params}`, { userToken });
  }

  listRunEventsAsUser(workspaceId, runId, userToken) {
    return this.userSelect("automation_run_events", new URLSearchParams({ select: "id,event_type,message,step_index,evidence,created_at", workspace_id: `eq.${workspaceId}`, run_id: `eq.${runId}`, order: "id.asc", limit: "500" }), userToken);
  }

  listApprovalsAsUser(workspaceId, userToken) {
    return this.userSelect("approvals", new URLSearchParams({ select: "id,run_id,action_type,action_summary,payload,status,expires_at,reviewed_at,created_at", workspace_id: `eq.${workspaceId}`, status: "eq.pending", order: "created_at.desc", limit: "100" }), userToken);
  }

  listAuditAsUser(workspaceId, userToken, limit = 100) {
    return this.userSelect("audit_events", new URLSearchParams({ select: "id,event_type,subject_type,subject_id,details,created_at", workspace_id: `eq.${workspaceId}`, order: "created_at.desc", limit: String(Math.max(1, Math.min(200, limit))) }), userToken);
  }

  cancelAsUser(workspaceId, runId, userToken) {
    return this.rpc("cancel_automation_run", { p_workspace_id: workspaceId, p_run_id: runId }, { userToken });
  }

  async reviewApprovalAsUser(workspaceId, approvalId, decision, userToken) {
    const pending = await this.userSelect("approvals", new URLSearchParams({ select: "id", id: `eq.${approvalId}`, workspace_id: `eq.${workspaceId}`, status: "eq.pending", limit: "1" }), userToken);
    if (!Array.isArray(pending) || !pending.length) return false;
    return this.rpc("review_approval", { p_approval_id: approvalId, p_decision: decision }, { userToken });
  }

  async serviceSelect(table, query) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
    return this.request(`/rest/v1/${encodeURIComponent(table)}?${params}`, { service: true });
  }

  serviceInsert(table, rows) {
    return this.request(`/rest/v1/${encodeURIComponent(table)}`, { method: "POST", body: rows, service: true, headers: { Prefer: "return=minimal" } });
  }

  servicePatch(table, query, body) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
    return this.request(`/rest/v1/${encodeURIComponent(table)}?${params}`, { method: "PATCH", body, service: true, headers: { Prefer: "return=minimal" } });
  }

  claimJobs(workerId, limit = 5) {
    return this.rpc("claim_automation_jobs", { p_worker_id: workerId, p_limit: Math.max(1, Math.min(50, limit)) }, { service: true });
  }
  renewLease(jobId, workerId, seconds = 60) {
    return this.rpc("renew_automation_job_lease", { p_job_id: jobId, p_worker_id: workerId, p_extension_seconds: seconds }, { service: true });
  }
  finishJob(jobId, workerId, result) {
    return this.rpc("finish_automation_job", { p_job_id: jobId, p_worker_id: workerId, p_result: result }, { service: true });
  }
  failJob(jobId, workerId, errorCode, delaySeconds = 30, retryable = true) {
    return this.rpc("fail_automation_job", { p_job_id: jobId, p_worker_id: workerId, p_error_code: errorCode, p_retry_delay_seconds: delaySeconds, p_retryable: retryable }, { service: true });
  }
  pauseJob(jobId, workerId, approvalId) {
    return this.rpc("pause_automation_job_for_approval", { p_job_id: jobId, p_worker_id: workerId, p_approval_id: approvalId }, { service: true });
  }
  enqueueScheduled(automationId, dueAt, nextAt, input = {}) {
    return this.rpc("enqueue_scheduled_automation_run", { p_automation_id: automationId, p_due_at: dueAt, p_next_run_at: nextAt, p_input: input }, { service: true });
  }

  async recordEvent(event) {
    const row = {
      workspace_id: event.workspaceId,
      run_id: event.runId,
      event_type: event.type,
      message: event.message || "",
      evidence: event.evidence || {},
      step_index: event.stepIndex ?? null,
    };
    return this.serviceInsert("automation_run_events", [row]);
  }
}
