import assert from "node:assert/strict";
import test from "node:test";
import { createApiServer } from "../src/api/server.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const automationId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";

async function withServer(fn, overrides = {}) {
  const calls = [];
  const store = {
    authenticateUser: async (token) => { calls.push(["auth", token]); return { id: "user-a" }; },
    enqueueAsUser: async (...args) => { calls.push(["enqueue-user", ...args]); return { run_id: runId, job_id: "job-a", status: "queued" }; },
    enqueueWithApiKey: async (...args) => { calls.push(["enqueue-key", ...args]); return { run_id: runId, job_id: "job-a", status: "queued" }; },
    getRunAsUser: async (workspaceId) => { calls.push(["get-run", workspaceId]); return workspaceId === workspaceA ? { id: runId, workspace_id: workspaceA, status: "queued" } : null; },
    listRunEventsAsUser: async (workspaceId, id) => { calls.push(["events", workspaceId, id]); return [{ event_type: "operator.step_verified", evidence: { proof: "readback" } }]; },
    listApprovalsAsUser: async (workspaceId) => { calls.push(["approvals", workspaceId]); return [{ id: "approval", status: "pending" }]; },
    listAuditAsUser: async (workspaceId) => { calls.push(["audit", workspaceId]); return [{ event_type: "automation.run_queued" }]; },
    cancelAsUser: async (workspaceId, id) => { calls.push(["cancel", workspaceId, id]); return true; },
    reviewApprovalAsUser: async (...args) => { calls.push(["review", ...args]); return true; },
    ...overrides,
  };
  const server = createApiServer({ store, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, calls); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const req = (method, path, token, body) => fetch(path, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("run creation requires authentication and delegates workspace ownership to Supabase", async () => {
  await withServer(async (base, calls) => {
    const path = `${base}/v1/workspaces/${workspaceA}/automations/${automationId}/runs`;
    const denied = await fetch(path, { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    assert.equal(calls.some(([name]) => name === "enqueue-user"), false);
    const response = await req("POST", path, "jwt-user-a", { input: { task: "test" }, idempotency_key: "run-1" });
    assert.equal(response.status, 202);
    const call = calls.find(([name]) => name === "enqueue-user");
    assert.equal(call[1], workspaceA);
    assert.equal(call[5], "jwt-user-a");
  });
});

test("run reads are explicitly scoped by workspace, blocking cross-tenant enumeration", async () => {
  await withServer(async (base, calls) => {
    const pathA = `${base}/v1/workspaces/${workspaceA}/runs/${runId}`;
    const pathB = `${base}/v1/workspaces/${workspaceB}/runs/${runId}`;
    assert.equal((await req("GET", pathA, "jwt-user-a")).status, 200);
    assert.equal((await req("GET", pathB, "jwt-user-a")).status, 404);
    assert.deepEqual(calls.filter(([name]) => name === "get-run").map(([, workspace]) => workspace), [workspaceA, workspaceB]);
  });
});

test("webhook API key is accepted only on webhook route and secret-like job input is rejected", async () => {
  await withServer(async (base, calls) => {
    const webhook = `${base}/v1/webhooks/${workspaceA}/${automationId}/runs`;
    const response = await req("POST", webhook, "hntr_0123456789abcdefghijklmno", { input: { event: "created" } });
    assert.equal(response.status, 202);
    assert.equal(calls.some(([name]) => name === "enqueue-key"), true);
    const unsafe = await req("POST", `${base}/v1/workspaces/${workspaceA}/automations/${automationId}/runs`, "jwt-user-a", { input: { api_key: "literal-secret" } });
    assert.equal(unsafe.status, 400);
    assert.equal(calls.some(([name]) => name === "enqueue-user"), false);
  });
});

test("progress, approvals, audit, cancellation and review require an authenticated scoped workspace route", async () => {
  await withServer(async (base, calls) => {
    const headersToken = "jwt-user-a";
    assert.equal((await req("GET", `${base}/v1/workspaces/${workspaceA}/runs/${runId}/events`, headersToken)).status, 200);
    assert.equal((await req("GET", `${base}/v1/workspaces/${workspaceA}/approvals`, headersToken)).status, 200);
    assert.equal((await req("GET", `${base}/v1/workspaces/${workspaceA}/audit`, headersToken)).status, 200);
    assert.equal((await req("POST", `${base}/v1/workspaces/${workspaceA}/runs/${runId}/cancel`, headersToken, {})).status, 200);
    assert.equal((await req("POST", `${base}/v1/workspaces/${workspaceA}/approvals/${runId}`, headersToken, { decision: "approved" })).status, 200);
    assert.deepEqual(calls.filter(([name]) => ["events", "approvals", "audit"].includes(name)).map(([name, workspace]) => [name, workspace]), [["events", workspaceA], ["approvals", workspaceA], ["audit", workspaceA]]);
  });
});
