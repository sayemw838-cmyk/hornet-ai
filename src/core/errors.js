export class HornetError extends Error {
  constructor(code, message, { status = 500, retryable = false, details = undefined } = {}) {
    super(message);
    this.name = "HornetError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export function safeErrorCode(error) {
  const raw = String(error?.code || error?.name || "worker_error").toLowerCase();
  return raw.replace(/[^a-z0-9_]/g, "_").slice(0, 80) || "worker_error";
}
