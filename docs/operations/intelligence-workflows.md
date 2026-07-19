# Intelligence Workflow Operations

This runbook covers the disabled-by-default `intelligence.workflow.v1` Phase 2 slice. Kortix remains the system of record. The only executable leaf is `studio.image.generate@1.0.0`; video, voice, 3D, digital-human, and batch-remix execution are outside this gate.

## Production boundary

Keep `INTELLIGENCE_WORKFLOWS_ENABLED=false` in production until a separately reviewed rollout binds the scheduler, installed Agent/card sources, provider/storage readiness, alerts, and protected smoke checks. The current application composition exposes no global Agent Card and does not start a production workflow scheduler. The PostgreSQL coordinator remains the default design; no Temporal package is installed because the Task 12 local test server preflight did not pass.

Enabling the route flag alone is not rollout approval. It constructs the project-scoped service and Review Center adapter only. Existing Studio, billing, credential, asset, Provider, and IAM ownership remains unchanged.

## Required gates

Run the no-secret protocol fixtures:

```bash
pnpm --filter kortix-api exec bun test src/__tests__/e2e-intelligence-protocol.test.ts
pnpm --filter kortix-api exec bun test src/__tests__/e2e-intelligence-workflow.test.ts
pnpm --filter @kortix/cli exec bun test src/__tests__/e2e-intelligence-mcp.test.ts
```

Run the disposable PostgreSQL concurrency, lease-restart, approval, payload-index, and Review Center fixture. CI requires this command; local execution may explicitly skip only when Docker is unavailable.

```bash
RUN_INTEGRATION_TESTS=1 pnpm --filter kortix-api exec bun test src/intelligence/workflows/postgres.integration.test.ts
```

The required object-store gate remains the pinned MinIO S3 conformance command in `.github/workflows/ci.yml`. The full package/typecheck gate is recorded in `docs/plans/2026-07-18-intelligence-workflow-evaluation-plan.md` Task 13.

## Telemetry

The optional scheduler sink emits only these low-cardinality series:

- `intelligence_workflow_scheduler_runs_total{outcome}`
- `intelligence_workflow_scheduler_nodes_total{outcome}`
- `intelligence_workflow_scheduler_run_duration_seconds{outcome}`

The optional span is `intelligence.workflow.scheduler.run`. It accepts a valid W3C `traceparent` and uses only `gen_ai.operation.name`, `gen_ai.system`, `gen_ai.tool.name`, and `kortix.workflow.outcome`. Never export account/project/user IDs, prompts, responses, payload/object refs, URLs, credentials, raw Provider bodies, or exception messages.

Recommended initial alerts after an approved rollout:

- Any sustained `outcome="failed"` scheduler run rate.
- Increasing `outcome="lease_lost"` without a matching completion rate.
- P95 scheduler duration approaching the configured interval.
- A growing count of active workflow payload rows without terminal runs.
- Runs remaining in `waiting_approval` beyond the team's review SLO.

## Incident handling

1. Disable new starts with `INTELLIGENCE_WORKFLOWS_ENABLED=false`; do not delete run, approval, event, task, job, or payload-index rows.
2. Preserve stable run/node/task/job IDs, event sequences, reason codes, route policy version, and evaluation version.
3. Confirm project fencing and Agent/card revocation before inspecting execution state.
4. Reconcile an attached task through public task events. Do not resubmit directly to a Provider or write billing/Studio tables.
5. Re-run the focused acceptance and PostgreSQL fixture after correction.

## Rollback

Set `INTELLIGENCE_WORKFLOWS_ENABLED=false`, stop the optional scheduler cleanly, and leave additive migrations in place. Do not down-migrate workflow tables during an incident. Existing image tasks and Studio jobs continue through their existing service/worker path; paused or running workflows remain durable for later replay or operator cancellation.

Rollback must not enable a fallback Provider, expose a payload ref, or bypass Review Center. A code rollback is acceptable only when its API contracts still reject unknown versions and the database schema remains forward-compatible with stored Phase 2 rows.

## Redaction

Treat a Redaction scan failure as a release blocker. Search captured HTTP, MCP, A2A, metric, trace, and operator output for prompts, responses, authorization values, credentials, signed URLs, object refs, Provider URLs/bodies, and exception text. Public workflow events may contain stable IDs, status, fixed reason codes, asset IDs, route reason codes, and evaluation versions only.
