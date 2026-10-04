import { HornetError } from "../core/errors.js";
import { sanitizeForEvidence } from "../core/permissions.js";

function endpointFor(connection) {
  let url;
  try { url = new URL(connection.endpoint_url); } catch { throw new HornetError("mcp_endpoint_invalid", "An MCP endpoint URL is invalid.", { status: 422 }); }
  const hosts = Array.isArray(connection.allowed_hosts) ? connection.allowed_hosts.map((host) => String(host).toLowerCase()) : [];
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !hosts.includes(host) || host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new HornetError("mcp_host_not_allowed", "MCP endpoint must be HTTPS and its hostname must exactly match the workspace host allowlist.", { status: 403 });
  }
  return url;
}

async function readBounded(response, maxBytes = 1_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HornetError("mcp_response_too_large", "MCP response exceeded the 1 MiB limit.", { status: 502 });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function responseResult(response, id) {
  if (!response.ok) throw new HornetError("mcp_request_failed", "The configured MCP server request failed.", { status: response.status === 429 ? 503 : 502, retryable: response.status === 429 || response.status >= 500 });
  const text = await readBounded(response);
  let values = [];
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) { try { values.push(JSON.parse(data)); } catch { /* Ignore non-JSON keepalive frames. */ } }
    }
  } else {
    try { values = [text ? JSON.parse(text) : null]; } catch { values = []; }
  }
  const value = values.find((item) => item?.id === id) || values.find((item) => item?.jsonrpc === "2.0");
  if (!value || value.error) throw new HornetError("mcp_request_failed", "The configured MCP server request failed.", { status: 502 });
  return value.result;
}

async function connect(connection, { resolveSecret, fetchImpl }) {
  const url = endpointFor(connection);
  const secret = connection.secret_ref ? await resolveSecret(connection.secret_ref) : null;
  if (connection.secret_ref && (!secret || typeof secret !== "string")) throw new HornetError("mcp_secret_unavailable", "MCP credentials are unavailable from the configured secret store.", { status: 503 });
  let sessionId = null;
  let counter = 0;
  const requestSignal = (signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  const headers = () => ({ Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-03-26", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) });
  const rpc = async (method, params = {}, signal = undefined) => {
    const id = `hornet-${++counter}`;
    const response = await fetchImpl(url, { method: "POST", headers: headers(), signal: requestSignal(signal), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const returnedSession = response.headers.get("Mcp-Session-Id");
    if (returnedSession) sessionId = returnedSession;
    return responseResult(response, id);
  };
  if (connection.transport === "sse") throw new HornetError("mcp_transport_unsupported", "This runtime currently supports Streamable HTTP MCP connections; SSE transport needs a dedicated session adapter.", { status: 501 });
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hornet-worker", version: "0.1.0" } });
  const initialized = await fetchImpl(url, { method: "POST", headers: headers(), signal: requestSignal(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  if (!initialized.ok) throw new HornetError("mcp_initialize_failed", "MCP initialization did not complete.", { status: 502, retryable: initialized.status >= 500 });
  return { rpc, list: async () => (await rpc("tools/list", {}))?.tools || [] };
}

export async function createMcpTools({ connections = [], resolveSecret = async () => null, fetchImpl = globalThis.fetch } = {}) {
  const registry = {};
  for (const connection of connections) {
    if (connection.status !== "active" || !Array.isArray(connection.allowed_tools) || connection.allowed_tools.length === 0) continue;
    const client = await connect(connection, { resolveSecret, fetchImpl });
    const serverTools = await client.list();
    for (const serverTool of serverTools) {
      if (!connection.allowed_tools.includes(serverTool.name)) continue;
      const qualifiedName = `mcp.${connection.id}.${serverTool.name}`;
      const locallyDeclaredReadOnly = Array.isArray(connection.config?.read_only_tools) && connection.config.read_only_tools.includes(serverTool.name);
      // MCP server annotations are untrusted input; only local workspace-admin configuration can grant read-only treatment.
      const capability = locallyDeclaredReadOnly ? "read" : "write";
      registry[qualifiedName] = {
        name: qualifiedName,
        connectionId: connection.id,
        capability,
        description: String(serverTool.description || `MCP tool ${serverTool.name}`).slice(0, 1000),
        inputSchema: sanitizeForEvidence(serverTool.inputSchema || { type: "object" }),
        execute: async (args, { signal } = {}) => {
          const result = await client.rpc("tools/call", { name: serverTool.name, arguments: args }, signal);
          if (result?.isError) throw new HornetError("mcp_tool_error", "The MCP tool reported an execution error.", { status: 502, retryable: true });
          const evidence = sanitizeForEvidence(result?.structuredContent || result?.content || result);
          const structured = result?.structuredContent || {};
          return { success: true, verified: capability === "read" ? true : structured.verified === true, evidence };
        },
      };
    }
  }
  return registry;
}
