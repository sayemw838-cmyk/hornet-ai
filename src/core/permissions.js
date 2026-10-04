import { createHash } from "node:crypto";
import { HornetError } from "./errors.js";

const CAPABILITIES = new Set(["read", "write", "consequential"]);
const SECRET_KEY = /(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|private[_-]?key|credential|secret_value)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]{12,}|(?:sk|pk|ghp|github_pat|hntr)_[a-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export function classifyTool(tool) {
  const capability = String(tool?.capability || "").toLowerCase();
  if (!CAPABILITIES.has(capability)) throw new HornetError("tool_unclassified", "Tool capability is missing or untrusted.", { status: 403 });
  return capability;
}

export function assertToolAllowed(tool, { workspaceAllowlist = [], connectorAllowlist = null } = {}) {
  const capability = classifyTool(tool);
  const workspace = new Set(Array.isArray(workspaceAllowlist) ? workspaceAllowlist : []);
  const connector = connectorAllowlist == null ? null : new Set(Array.isArray(connectorAllowlist) ? connectorAllowlist : []);
  if (!workspace.has(tool.name) || (connector && !connector.has(tool.name))) {
    throw new HornetError("tool_not_allowed", "The requested tool is not allowed in this workspace.", { status: 403 });
  }
  return { capability, requiresApproval: capability !== "read" || tool.requiresApproval === true };
}

export function containsSecretLikeValue(value, depth = 0) {
  if (depth > 12) return true;
  if (typeof value === "string") return SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretLikeValue(item, depth + 1));
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => SECRET_KEY.test(key) || containsSecretLikeValue(item, depth + 1));
  return false;
}

export function sanitizeForEvidence(value, depth = 0) {
  if (depth > 12) return "[depth-limited]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForEvidence(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitizeForEvidence(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value ?? null;
}

export function actionDigest(toolName, args) {
  return createHash("sha256").update(JSON.stringify({ tool: toolName, args: sanitizeForEvidence(args) })).digest("hex");
}
