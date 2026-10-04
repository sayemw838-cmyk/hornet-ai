import assert from "node:assert/strict";
import test from "node:test";
import { executeOperator } from "../src/core/operator.js";
import { actionDigest } from "../src/core/permissions.js";

const run = { id: "run-1", workspace_id: "workspace-a", input: { goal: "compile report" } };
const automation = { name: "Report job", description: "compile report", definition: { objective: "compile report", tool_allowlist: ["read_report", "write_report"] } };
const agent = { name: "Report Worker", instructions: "Read, then verify." };
const skills = [{ id: "report-skill", name: "Report verification", description: "compile a verified report", instructions: "Keep evidence.", status: "published" }];
function ioHarness() {
  const events = [];
  const state = { plan: null, approval: null, paused: false };
  return {
    events,
    state,
    io: {
      emit: async (event) => events.push(event),
      getPlan: async () => state.plan,
      savePlan: async (_runId, _workspace, plan) => { state.plan = plan; },
      requestApproval: async (approval) => { state.approval = { id: "approval-1", payload: approval.payload }; return state.approval; },
      pauseForApproval: async () => { state.paused = true; return true; },
    },
  };
}

const verifiedReadTool = {
  name: "read_report", capability: "read", description: "Read report data", inputSchema: { type: "object" },
  execute: async () => ({ success: true, verified: true, evidence: "report row read" }),
};

 test("matches only published workspace skills and completes only with verified tool evidence", async () => {
  const harness = ioHarness();
  const model = { plan: async (context) => {
    assert.equal(context.skills[0].id, "report-skill");
    return { expected_outcome: "Report checked", steps: [{ title: "Read report", tool: "read_report", args: {}, verification: "Check report row" }] };
  } };
  const result = await executeOperator({ run, automation, agent, skills: [...skills, { ...skills[0], id: "draft", status: "draft", name: "Report draft" }], tools: { read_report: verifiedReadTool }, model, io: harness.io });
  assert.equal(result.status, "succeeded");
  assert.equal(result.outcome, "COMPLETE");
  assert.equal(result.evidence_status, "verified");
  assert.equal(harness.events.some((event) => event.type === "operator.step_verified"), true);
  assert.equal(harness.events.some((event) => event.type === "operator.outcome_verified"), true);
});

test("does not mark a successful tool response complete without explicit verification evidence", async () => {
  const harness = ioHarness();
  const model = { plan: async () => ({ steps: [{ tool: "read_report", args: {}, verification: "Check" }] }) };
  await assert.rejects(executeOperator({ run, automation, agent, skills, tools: { read_report: { ...verifiedReadTool, execute: async () => ({ success: true, verified: false, evidence: "" }) } }, model, io: harness.io }), (error) => error.code === "verification_failed");
  assert.equal(harness.events.some((event) => event.type === "operator.outcome_verified"), false);
});

test("write-capable tools pause for exact approval and are not executed beforehand", async () => {
  const harness = ioHarness();
  let calls = 0;
  const plan = { steps: [{ title: "Publish report", tool: "write_report", args: { destination: "workspace" }, verification: "Read back" }] };
  const writeTool = { name: "write_report", capability: "write", execute: async () => { calls += 1; return { success: true, verified: true, evidence: "published" }; } };
  const model = { plan: async () => plan };
  const result = await executeOperator({ run, automation, agent, skills, tools: { write_report: writeTool }, model, io: harness.io });
  assert.equal(result.status, "waiting_approval");
  assert.equal(calls, 0);
  assert.equal(harness.state.paused, true);
  assert.equal(harness.state.approval.payload.action_digest, actionDigest("write_report", plan.steps[0].args));
});

test("approval resumes only the identical planned action and still verifies it", async () => {
  const harness = ioHarness();
  const args = { destination: "workspace" };
  const plan = { steps: [{ title: "Publish report", tool: "write_report", args, verification: "Read back" }] };
  harness.state.plan = plan;
  let calls = 0;
  const tool = { name: "write_report", capability: "write", execute: async () => { calls += 1; return { success: true, verified: true, evidence: "output read back" }; } };
  const model = { plan: async () => { throw new Error("must reuse persisted plan"); } };
  const result = await executeOperator({ run, automation, agent, skills, tools: { write_report: tool }, model, io: harness.io, approvedAction: { id: "approval-1", payload: { step_index: 0, tool: "write_report", args, action_digest: actionDigest("write_report", args) } } });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "COMPLETE");
  await assert.rejects(executeOperator({ run, automation, agent, skills, tools: { write_report: tool }, model, io: harness.io, approvedAction: { id: "approval-1", payload: { step_index: 0, tool: "write_report", args, action_digest: "wrong" } } }), (error) => error.code === "approval_action_mismatch");
});

test("workspace allowlists deny unknown tools and secret-shaped tool arguments", async () => {
  const harness = ioHarness();
  const model = { plan: async () => ({ steps: [{ tool: "admin_delete", args: {}, verification: "check" }] }) };
  await assert.rejects(executeOperator({ run, automation, agent, skills, tools: {}, model, io: harness.io }), (error) => error.code === "no_tools_allowed");
  const secretModel = { plan: async () => ({ steps: [{ tool: "read_report", args: { api_key: "placeholder-value" }, verification: "check" }] }) };
  await assert.rejects(executeOperator({ run, automation, agent, skills, tools: { read_report: verifiedReadTool }, model: secretModel, io: harness.io }), (error) => error.code === "secret_in_tool_arguments");
});
