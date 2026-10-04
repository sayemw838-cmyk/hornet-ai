# Implementation notes

## Inspection and preservation

- Hornet repository baseline: README plus a GitHub Pages workflow; no app code, local migration files, or tests. CI is now tests-only; it does not deploy Pages.
- Inspected the existing Hornet Supabase project read-only. It is separate from AIRA_V2's Supabase project, has the `hornet_backend_foundation` and `workspace_invitations` migrations, and has no deployed Edge Functions.
- Existing schema/RPC contracts checked read-only: `automation_runs` has unique `(id, workspace_id)` and `(workspace_id, idempotency_key)`; `automation_jobs` has durable leases and one job per run; existing RPCs include authenticated/idempotent enqueue, atomic `SKIP LOCKED` claim, lease renewal, finish, bounded failure/retry, and owner/admin approval review. Existing tables expose the `agents`, `skills`, `mcp_connections`, and workspace columns selected by the worker.
- New `automation_run_events` uses the verified `(id, workspace_id)` unique key for its composite tenant-bound FK.
- No live Supabase objects or data were modified. The additive migration remains unapplied and no code has been deployed.

## AIRA patterns adapted (not copied)

- Deterministic lexical skill matching ranks published skills attached to the executing workspace agent.
- Operator executes a bounded plan → execute → observe → verify loop and refuses to infer completion from tool execution alone.
- Tool calls must be in the automation and connector allowlists. Capabilities come from trusted server adapters or explicit workspace-admin config; unknown capability/tool is denied.
- Write/consequential work creates a durable approval with an exact action digest, then pauses the lease. Approval resumes only the same action. Successful completion requires verification evidence for every planned step.
- Job/run progress, evidence, and audit entries are durable. Cancellation is checked during execution; leases are heartbeated; retries use capped backoff and the queue's attempt limit.
- Skill/job/model text is untrusted data and cannot grant permissions. The chat UI, AIRA repository, and AIRA database are not copied or modified.

## Integrations and secret boundaries

- Supabase service-role key, model provider keys, API credentials, and MCP OAuth tokens are injected at runtime. Webhook keys are hashed with SHA-256 before calling the database RPC; only a digest is compared with `workspace_api_keys.token_digest`.
- MCP transport support is Streamable HTTP only. Endpoint must be HTTPS and its hostname must exactly match the active connection allowlist. Only connection `allowed_tools` are registered. Remote annotations are ignored for permission classification: tools are write-capable unless explicitly named in that workspace connection's `config.read_only_tools`.
- MCP `secret_ref` is passed to a trusted runtime secret-resolver plugin; the built-in runtime does not fetch decrypted Vault values. Custom API integrations are trusted code loaded from `HORNET_TOOLS_MODULE`, not from database/skill code.
- Runtime and the migration reject common credential-bearing keys/pasted-token patterns in job input and ordinary agent, skill, automation, and MCP configuration. This is defense in depth, not a perfect detector for every opaque secret format.
- Logs include sanitized error codes/counts only, never request bodies or Authorization headers. Evidence is sanitized before persistence/return. A production reverse proxy must also be configured not to log authorization headers.

## Model and schedule safety

- Provider execution is off by default. The built-in adapter supports OpenAI-compatible HTTPS endpoints; the operator depends on an adapter contract, not vendor SDKs. No model is called “free” without workspace-operator verification.
- A call requires an injected key, explicit provider/model, maximum call/token limits, explicit rates and per-run budget, and `HORNET_MODEL_BILLING_APPROVED=true`. It pre-reserves max-token cost and requires reported usage. A zero price is user configuration, not a guarantee about provider billing.
- Schedule expressions use five-field cron in UTC. Non-UTC zones and legacy MCP SSE are explicitly unsupported. Missed occurrences are not replayed as a catch-up backlog; a due schedule is enqueued once and advances to its next occurrence.

## Tests and remaining work

The local Node test suite covers API authentication, tenant scoping, webhook key handling, secret-input rejection, progress/approval/audit endpoints, MCP host and tool allowlists, approval-before-write and exact-action binding, verified completion, bounded retry, cancellation checks, schedule parsing, provider budget gates, and webhook digest handling. Tests use fakes; there is no claim of production end-to-end validation.

Before any shared-environment use: parse/review and apply the migration on a disposable Supabase branch; provide secure API-key provisioning and Vault/external secret resolver; supply reviewed API tool modules and workspace agent/skill/automation config; verify provider tier/rates/quotas; run integration tests; then separately decide on hosting/deployment. Production controls still needed include TLS, CORS, rate limits, outbound egress restrictions, API/worker supervision, graceful shutdown, metrics, alerts, and operational recovery procedures.
