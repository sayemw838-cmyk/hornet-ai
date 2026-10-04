import assert from "node:assert/strict";
import test from "node:test";
import { processClaimedJob, workerTick } from "../src/worker/main.js";

const job = { id: "job-1", run_id: "run-1", workspace_id: "workspace-1", attempts: 4 };
function makeStore({ initialStatus = "queued" } = {}) {
  const calls = [];
  const run = { id: "run-1", workspace_id: "workspace-1", automation_id: "automation-1", input: { goal: "read report" }, status: initialStatus };
  const automation = { id: "automation-1", workspace_id: "workspace-1", agent_id: "agent-1", name: "Report", description: "read report", enabled: true, definition: { objective: "read report", tool_allowlist: ["read_report"] } };
  const agent = { id: "agent-1", workspace_id: "workspace-1", enabled: true, name: "Reader", instructions: "Read and verify." };
  const store = {
    calls,
    async serviceSelect(table) {
      if (table === "automation_runs") return [run];
      if (table === "automations") return [automation];
      if (table === "agents") return [agent];
      if (table === "agent_skills" || table === "skills" || table === "mcp_connections" || table === "automation_run_events" || table === "approvals") return [];
      return [];
    },
    async servicePatch(table, query, body) { calls.push(["patch", table, body]); if (table === "automation_runs") run.status = body.status; },
    async recordEvent(event) { calls.push(["event", event.type]); },
    async renewLease() { return true; },
    async claimJobs() { return [job]; },
    async failJob(...args) { calls.push(["fail", ...args]); return true; },
    async finishJob(...args) { calls.push(["finish", ...args]); return true; },
    async pauseJob() { return true; },
    async serviceInsert() { return null; },
  };
  return store;
}

test("retryable worker errors go through bounded exponential retry policy", async () => {
  const store = makeStore();
  const modelProvider = { startRun: () => ({ plan: async () => { throw Object.assign(new Error("private provider message"), { code: "upstream_timeout", retryable: true }); } }) };
  const tools = { read_report: { name: "read_report", capability: "read", execute: async () => ({ success: true, verified: true, evidence: "read" }) } };
  const results = await workerTick({ store, workerId: "worker-a", modelProvider, tools, maxClaim: 2 });
  assert.equal(results[0].status, "attempt_failed");
  const fail = store.calls.find(([name]) => name === "fail");
  assert.equal(fail[3], "upstream_timeout");
  assert.equal(fail[4], 120); // attempt 4: 15 * 2^(4-1)
  assert.equal(fail[5], true);
  assert.equal(JSON.stringify(store.calls).includes("private provider message"), false);
});

test("successful jobs are finalized only after a tool returns verifiable evidence", async () => {
  const store = makeStore();
  const modelProvider = { startRun: () => ({ plan: async () => ({ expected_outcome: "Report read", steps: [{ tool: "read_report", args: {}, verification: "Confirm readback" }] }), usage: () => ({ calls: 1 }) }) };
  const tools = { read_report: { name: "read_report", capability: "read", execute: async () => ({ success: true, verified: true, evidence: "row read and confirmed" }) } };
  const result = await processClaimedJob(job, { store, workerId: "worker-a", modelProvider, tools });
  assert.equal(result.outcome, "COMPLETE");
  const finish = store.calls.find(([name]) => name === "finish");
  assert.equal(finish[3].evidence_status, "verified");
  assert.equal(store.calls.some(([name, type]) => name === "event" && type === "operator.outcome_verified"), true);
});

test("cancelled runs are skipped before loading an agent or executing tools", async () => {
  const store = makeStore({ initialStatus: "cancelled" });
  const result = await processClaimedJob(job, { store, workerId: "worker-a", modelProvider: null, tools: {} });
  assert.deepEqual(result, { status: "cancelled", skipped: true });
  assert.equal(store.calls.some(([name]) => name === "finish" || name === "fail"), false);
});
