# Hornet AI

**Hornet is a worker-agent platform, not a conversational chatbot.** Authenticated APIs, scoped webhooks, and UTC schedules create durable jobs. Background workers run bounded workspace-agent plans, emit progress and evidence, pause for required approvals, and only report completion after verification.

## Preserved foundation

The existing Hornet Supabase project has its own multi-user foundation: profiles, personal/team workspaces, membership and invitations; RLS-protected agents, skills, MCP metadata, automations, runs, and approvals; workspace API-key digest storage; audit events and Vault; and atomic job claim, lease, retry, and completion RPCs. The original Git repository contained only a README and a GitHub Pages workflow. This code adapts AIRA_V2's skill matching, Operator Agent plan/execute/observe/verify loop, approvals, and evidence conventions; it does not copy AIRA's chat UI or modify AIRA_V2 or its Supabase project.

## Runtime

- `src/api/server.js` — JWT-authenticated run, status, progress, approval, and audit endpoints; scoped workspace API keys can enqueue webhook runs after the migration is applied.
- `src/worker/main.js` — durable-job polling/claiming, lease renewal, cancellation observation, bounded retries, schedule enqueueing, workspace context loading, and evidence persistence.
- `src/core/operator.js` — workspace skill matching; bounded plans; per-step tool authorization; approval before write/consequential actions; observation and evidence-gated completion.
- `src/adapters/mcp-tools.js` — Streamable HTTP MCP client. Only active connections, explicitly allowed tool names, exact HTTPS hostname allowlists, and a secret-resolver reference are used. Remote MCP annotations cannot declare a tool read-only: workspace-admin configuration must explicitly list `config.read_only_tools`; all other MCP tools require approval.
- `src/adapters/model-provider.js` — provider-neutral operator interface with a built-in disabled-by-default OpenAI-compatible HTTP adapter. Model calls require explicit prices, limits, a per-run budget, and `HORNET_MODEL_BILLING_APPROVED=true`.
- `src/adapters/secret-resolver.js` — pluggable worker-only resolver contract for Supabase Vault or an external secret manager. Secret values are resolved in memory, never from skill text or ordinary connection config.
- Custom API integrations can be provided as trusted server-side tool modules via `HORNET_TOOLS_MODULE`; those modules must declare each tool's capability and use the supplied secret resolver. No arbitrary code or endpoint is loaded from a skill.
- `supabase/migrations/20261004150000_hornet_worker_runtime.sql` — additive progress/evidence, webhook digest, pause/resume, cancel/schedule, and secret-shaped-config guard migration. **Not applied to the live project.**

## Local checks and run

Requires Node.js 20+ and an already configured Hornet Supabase project. The test suite uses local fakes and makes no live Supabase calls.

```bash
npm test
npm run check
cp .env.example .env   # replace placeholders; do not commit .env
npm run start:api
# in a separate process:
npm run start:worker
```

Inject `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from a runtime secret manager. The worker's service-role key is server-only and must never reach a browser. Set `HORNET_SECRET_RESOLVER_MODULE` to a trusted module that exports `createSecretResolver()` returning `{ resolve(secretRef) }`. A custom API tool module exports `createTools({ secretResolver })`.

The API binds to `127.0.0.1` by default. Before external hosting, configure TLS, deliberate CORS, request/rate limits, worker supervision, and health/metrics monitoring. There is no chat-first interface and no deploy workflow in CI.

## API v1

Every workspace route requires a Supabase user JWT; authorization is delegated to RLS and the existing/added workspace-scoped RPCs.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/v1/workspaces/{workspaceId}/automations/{automationId}/runs` | Enqueue a run with `{ "input": {}, "idempotency_key": "..." }` |
| `POST` | `/v1/webhooks/{workspaceId}/{automationId}/runs` | Enqueue with `Authorization: Bearer hntr_...` and `automation:trigger` scope |
| `GET` | `/v1/workspaces/{workspaceId}/runs/{runId}` | Read the workspace-scoped durable run |
| `GET` | `/v1/workspaces/{workspaceId}/runs/{runId}/events` | Read progress and verification evidence |
| `GET` | `/v1/workspaces/{workspaceId}/approvals` | List pending approval actions |
| `POST` | `/v1/workspaces/{workspaceId}/approvals/{approvalId}` | Owner/admin approval decision: `{ "decision": "approved" | "rejected" }` |
| `GET` | `/v1/workspaces/{workspaceId}/audit?limit=100` | Read workspace audit events |
| `POST` | `/v1/workspaces/{workspaceId}/runs/{runId}/cancel` | Request durable cancellation |
| `GET` | `/health` | Liveness only; no credentials or user data |

A `202 queued` response is not completion. Poll the run and its events; only `outcome: COMPLETE` with `evidence_status: verified` represents a verified outcome. Webhook API keys are SHA-256 hashed in the API process and only their digest crosses into the database RPC.

## Workspace tool configuration

An automation definition must set `tool_allowlist` to the exact registered names. For MCP tools, names are `mcp.{connectionId}.{serverToolName}`. The MCP connection's own `allowed_tools` list must also contain the server tool name, and `automation.definition.connector_tool_allowlists[connectionId]` must repeat the exact qualified tool name. MCP tools default to write/consequential unless that trusted connection's local `config.read_only_tools` explicitly lists the tool name. All write/consequential calls pause for approval bound to the exact tool arguments digest; approval does not widen an allowlist.

Only `streamable_http` MCP transport is implemented; legacy SSE connections are blocked. Exact allowed hostnames and HTTPS are required. A deployed environment should additionally enforce outbound network egress/SSRF controls. Workspace OAuth/API credentials belong in Vault or an external secret manager referenced by `secret_ref`, not in MCP `config`.

## Model and cost behavior

Model execution is off by default. Hornet does not claim a model/tier is free. To use a verified provider free tier or a user-owned key, the workspace operator must verify that provider's current tier/quotas and explicitly configure the endpoint, model, key in the secret store, bounded calls/tokens, token rates, per-run budget, and billing approval flag. A zero rate is a deliberate operator-supplied assumption, not a Hornet guarantee of zero provider charges. Before a call, the runtime reserves the configured maximum-token cost; afterward, it requires reported usage and meters against the configured rates. Missing usage or budget overrun stops the run.

## Readiness and limits

**Runnable here:** tests, HTTP API with fake store, core operator, skill matching, approval/permission guards, schedule parser, MCP Streamable HTTP adapter with fake server, and Supabase REST/RPC adapters. The API/worker can connect to the existing project only after the new migration is reviewed and applied in a development branch and runtime secrets are provisioned.

**Not yet production-ready:** no API key provisioning UI/command; no built-in OAuth/Vault resolver (provide a trusted resolver module); no built-in catalog of external API tools; no SSE transport; no production host deployment, TLS/CORS/rate limiting, high-availability scheduler, operational metrics/alerting, or end-to-end test against a disposable Supabase branch. The migration is still unapplied; no remote database or deployment was changed as part of this code work.
