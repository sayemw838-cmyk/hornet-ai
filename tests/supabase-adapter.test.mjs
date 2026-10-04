import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SupabaseRest } from "../src/adapters/supabase-rest.js";

const rawKey = "hntr_verysecretapikeyvalue0123456789";
const jsonResponse = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });

test("workspace API keys are hashed before the RPC call and never sent raw", async () => {
  const calls = [];
  const store = new SupabaseRest({ url: "https://hornet.example", publishableKey: "public", serviceRoleKey: "server-secret", fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse([{ run_id: "run", job_id: "job", status: "queued" }]); } });
  await store.enqueueWithApiKey("workspace", "automation", {}, "idem", rawKey);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.p_key_digest, `\\x${createHash("sha256").update(rawKey).digest("hex")}`);
  assert.equal(JSON.stringify(body).includes(rawKey), false);
  assert.equal(calls[0].options.headers.Authorization, "Bearer server-secret");
});

test("user run, event, approval and audit reads are tenant filtered and use caller JWT", async () => {
  const calls = [];
  const store = new SupabaseRest({ url: "https://hornet.example", publishableKey: "public", serviceRoleKey: "server-secret", fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse([]); } });
  await store.getRunAsUser("workspace-a", "run-a", "jwt-user-a");
  await store.listRunEventsAsUser("workspace-a", "run-a", "jwt-user-a");
  await store.listApprovalsAsUser("workspace-a", "jwt-user-a");
  await store.listAuditAsUser("workspace-a", "jwt-user-a");
  assert.equal(calls.every(({ options }) => options.headers.Authorization === "Bearer jwt-user-a"), true);
  assert.equal(calls.every(({ url }) => url.includes("workspace_id=eq.workspace-a")), true);
});

test("approval decisions first verify the pending approval belongs to the URL workspace", async () => {
  const calls = [];
  const store = new SupabaseRest({ url: "https://hornet.example", publishableKey: "public", serviceRoleKey: "server-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(url.includes("/approvals?") ? [{ id: "approval-a" }] : true);
  } });
  assert.equal(await store.reviewApprovalAsUser("workspace-a", "approval-a", "approved", "jwt-user-a"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.includes("workspace_id=eq.workspace-a"), true);
  assert.equal(calls[0].options.headers.Authorization, "Bearer jwt-user-a");
  const rpcBody = JSON.parse(calls[1].options.body);
  assert.equal(rpcBody.p_approval_id, "approval-a");
  const blockedCalls = [];
  const noMatch = new SupabaseRest({ url: "https://hornet.example", publishableKey: "public", serviceRoleKey: "server-secret", fetchImpl: async (url) => { blockedCalls.push(url); return jsonResponse([]); } });
  assert.equal(await noMatch.reviewApprovalAsUser("workspace-b", "approval-a", "approved", "jwt-user-a"), false);
  assert.equal(blockedCalls.length, 1);
});
