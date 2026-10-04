import assert from "node:assert/strict";
import test from "node:test";
import { createMcpTools } from "../src/adapters/mcp-tools.js";
import { assertToolAllowed } from "../src/core/permissions.js";

const connection = { id: "mcp-1", status: "active", endpoint_url: "https://mcp.example.test/rpc", allowed_hosts: ["mcp.example.test"], allowed_tools: ["lookup", "mutate"], config: { read_only_tools: ["lookup"] }, transport: "streamable_http", secret_ref: "vault-ref-1" };

test("MCP tools require allowed hostname and surface server tools only when explicitly workspace-allowlisted", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ method: body.method, authorized: options.headers.Authorization === "Bearer never-log-this-secret" });
    if (body.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [
      { name: "lookup", description: "Read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
      { name: "mutate", description: "Write", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    ] } }), { status: 200, headers: { "content-type": "application/json" } });
    if (body.id) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { verified: true, row: "x" } } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("", { status: 202 });
  };
  const tools = await createMcpTools({ connections: [connection], resolveSecret: async (ref) => { assert.equal(ref, "vault-ref-1"); return "never-log-this-secret"; }, fetchImpl });
  assert.deepEqual(Object.keys(tools), ["mcp.mcp-1.lookup", "mcp.mcp-1.mutate"]);
  assert.equal(tools["mcp.mcp-1.lookup"].capability, "read");
  assert.equal(tools["mcp.mcp-1.mutate"].capability, "write");
  assert.equal(assertToolAllowed(tools["mcp.mcp-1.lookup"], { workspaceAllowlist: ["mcp.mcp-1.lookup"], connectorAllowlist: ["mcp.mcp-1.lookup"] }).requiresApproval, false);
  assert.throws(() => assertToolAllowed(tools["mcp.mcp-1.mutate"], { workspaceAllowlist: ["mcp.mcp-1.mutate"], connectorAllowlist: [] }), (error) => error.code === "tool_not_allowed");
  assert.equal(requests.every((request) => request.authorized), true);
  const read = await tools["mcp.mcp-1.lookup"].execute({ query: "safe" });
  assert.equal(read.verified, true);
  assert.equal(JSON.stringify(read).includes("never-log-this-secret"), false);
  assert.equal(assertToolAllowed(tools["mcp.mcp-1.mutate"], { workspaceAllowlist: ["mcp.mcp-1.mutate"], connectorAllowlist: ["mcp.mcp-1.mutate"] }).requiresApproval, true);
});

test("MCP endpoints outside exact HTTPS host allowlists are rejected before network access", async () => {
  let calls = 0;
  await assert.rejects(createMcpTools({ connections: [{ ...connection, endpoint_url: "http://mcp.example.test/rpc" }], resolveSecret: async () => null, fetchImpl: async () => { calls += 1; } }), (error) => error.code === "mcp_host_not_allowed");
  await assert.rejects(createMcpTools({ connections: [{ ...connection, endpoint_url: "https://other.example.test/rpc" }], resolveSecret: async () => null, fetchImpl: async () => { calls += 1; } }), (error) => error.code === "mcp_host_not_allowed");
  assert.equal(calls, 0);
});
