import http from "node:http";
import { pathToFileURL } from "node:url";
import { SupabaseRest } from "../adapters/supabase-rest.js";
import { HornetError } from "../core/errors.js";
import { containsSecretLikeValue, sanitizeForEvidence } from "../core/permissions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_LIMIT = 64 * 1024;

function send(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new HornetError("request_too_large", "Request body exceeds the 64 KiB limit.", { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new HornetError("invalid_json", "Request body must be a JSON object.", { status: 400 });
  }
}

function bearer(request) {
  const value = String(request.headers.authorization || "");
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  if (!match) throw new HornetError("authentication_required", "A bearer credential is required.", { status: 401 });
  return match[1];
}

function requireUuid(...values) {
  if (!values.every((value) => UUID.test(value))) throw new HornetError("invalid_identifier", "A valid UUID path parameter is required.", { status: 400 });
}

function validateRunBody(body) {
  const input = body.input === undefined ? {} : body.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HornetError("invalid_input", "Run input must be a JSON object.", { status: 400 });
  if (containsSecretLikeValue(input)) throw new HornetError("secret_in_input", "Credentials must be configured in a secret store, not in job input.", { status: 400 });
  const key = body.idempotency_key == null ? null : String(body.idempotency_key);
  if (key !== null && (key.length < 1 || key.length > 128)) throw new HornetError("invalid_idempotency_key", "Idempotency key must contain 1 to 128 characters.", { status: 400 });
  return { input, key };
}

export function createApiServer({ store, logger = console } = {}) {
  if (!store) throw new Error("A Supabase store adapter is required.");
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const method = request.method || "GET";
      if (method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, service: "hornet-api", mode: "worker-agent" });

      let match = /^\/v1\/workspaces\/([^/]+)\/automations\/([^/]+)\/runs$/.exec(url.pathname);
      if (method === "POST" && match) {
        const [, workspaceId, automationId] = match;
        requireUuid(workspaceId, automationId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const { input, key } = validateRunBody(await readJson(request));
        const result = await store.enqueueAsUser(workspaceId, automationId, input, key, token);
        return send(response, 202, { run_id: result?.run_id, job_id: result?.job_id, status: result?.status || "queued" });
      }

      match = /^\/v1\/webhooks\/([^/]+)\/([^/]+)\/runs$/.exec(url.pathname);
      if (method === "POST" && match) {
        const [, workspaceId, automationId] = match;
        requireUuid(workspaceId, automationId);
        const apiKey = bearer(request);
        if (!apiKey.startsWith("hntr_")) throw new HornetError("invalid_webhook_key", "A scoped Hornet workspace API key is required.", { status: 401 });
        const { input, key } = validateRunBody(await readJson(request));
        const result = await store.enqueueWithApiKey(workspaceId, automationId, input, key, apiKey);
        return send(response, 202, { run_id: result?.run_id, job_id: result?.job_id, status: result?.status || "queued" });
      }

      match = /^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && match) {
        const [, workspaceId, runId] = match;
        requireUuid(workspaceId, runId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const run = await store.getRunAsUser(workspaceId, runId, token);
        if (!run) throw new HornetError("run_not_found", "Run not found in this workspace.", { status: 404 });
        return send(response, 200, sanitizeForEvidence(run));
      }

      match = /^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (method === "GET" && match) {
        const [, workspaceId, runId] = match;
        requireUuid(workspaceId, runId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const events = await store.listRunEventsAsUser(workspaceId, runId, token);
        return send(response, 200, { events: sanitizeForEvidence(Array.isArray(events) ? events : []) });
      }

      match = /^\/v1\/workspaces\/([^/]+)\/approvals$/.exec(url.pathname);
      if (method === "GET" && match) {
        const [, workspaceId] = match;
        requireUuid(workspaceId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const approvals = await store.listApprovalsAsUser(workspaceId, token);
        return send(response, 200, { approvals: sanitizeForEvidence(Array.isArray(approvals) ? approvals : []) });
      }

      match = /^\/v1\/workspaces\/([^/]+)\/audit$/.exec(url.pathname);
      if (method === "GET" && match) {
        const [, workspaceId] = match;
        requireUuid(workspaceId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const requestedLimit = Number(url.searchParams.get("limit") || 100);
        const audit = await store.listAuditAsUser(workspaceId, token, Number.isFinite(requestedLimit) ? requestedLimit : 100);
        return send(response, 200, { events: sanitizeForEvidence(Array.isArray(audit) ? audit : []) });
      }

      match = /^\/v1\/workspaces\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && match) {
        const [, workspaceId, runId] = match;
        requireUuid(workspaceId, runId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const cancelled = await store.cancelAsUser(workspaceId, runId, token);
        if (!(cancelled === true || cancelled === "true")) throw new HornetError("run_not_cancellable", "Run could not be cancelled; it may be terminal or outside this workspace.", { status: 409 });
        return send(response, 200, { run_id: runId, status: "cancelled" });
      }

      match = /^\/v1\/workspaces\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
      if (method === "POST" && match) {
        const [, workspaceId, approvalId] = match;
        requireUuid(workspaceId, approvalId);
        const token = bearer(request);
        await store.authenticateUser(token);
        const body = await readJson(request);
        if (!new Set(["approved", "rejected"]).has(body.decision)) throw new HornetError("invalid_decision", "Decision must be approved or rejected.", { status: 400 });
        const reviewed = await store.reviewApprovalAsUser(workspaceId, approvalId, body.decision, token);
        if (!(reviewed === true || reviewed === "true")) throw new HornetError("approval_not_pending", "Approval is no longer pending, expired, or you lack workspace owner/admin permission.", { status: 409 });
        return send(response, 200, { approval_id: approvalId, status: body.decision });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      const status = Number(error?.status) >= 400 && Number(error?.status) <= 599 ? Number(error.status) : 500;
      const code = String(error?.code || "request_failed").replace(/[^a-z0-9_]/gi, "_").slice(0, 80);
      if (status >= 500) logger.error?.("hornet_api_request_failed", { code });
      return send(response, status, { error: code, message: error instanceof HornetError ? error.message : (status < 500 ? "Request rejected." : "Request could not be completed.") });
    }
  });
}

export function startApi(env = process.env) {
  const store = new SupabaseRest({ url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
  const server = createApiServer({ store });
  const host = env.HORNET_API_HOST || "127.0.0.1";
  const port = Number(env.HORNET_API_PORT || 8787);
  server.listen(port, host, () => console.info("hornet_api_listening", { host, port }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startApi();
