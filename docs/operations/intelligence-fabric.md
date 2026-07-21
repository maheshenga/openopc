# Intelligence Fabric Protocol Operations

This runbook covers the project-scoped `intelligence.v1` protocol slice for image generation. It records how to validate the API, MCP, A2A, IAM, and task/event contracts without enabling a production Studio deployment. Image Studio is the only first-party Studio product; video, voice, 3D, avatar/digital-human, and batch-remix finished-product pages are cancelled product scope.

## Supported boundary

The executable capability in this slice is `studio.image.generate`. REST, MCP, and A2A are protocol faces over the same project IAM checks, deterministic Agent Card, `IntelligenceTaskService`, Studio job bridge, and public task-event contract. A2A remains project-scoped; there is no global unauthenticated Agent Card route.

The acceptance fixtures use the in-memory task store, in-memory Studio repository, and deterministic fake provider. They perform no external provider or object-storage I/O and require no credential values. Passing these fixtures is contract evidence, not permission to change a production Studio enablement flag.

## Prerequisites

- Node.js 22, Bun, and pnpm 8 are available.
- Workspace dependencies are installed from the checked-in lockfile.
- Run commands from the repository root.
- No provider credential, database URL, storage credential, or decrypted application environment is required for the two protocol acceptance fixtures.
- The PostgreSQL migration integration gate additionally requires the repository's normal test database prerequisites.

## Recorded fake-provider flow

The API acceptance fixture performs this sequence:

1. Discover the governed image capability and execution target.
2. Fetch the deterministic local Agent Card.
3. Create one REST task and replay it through REST and A2A with the same idempotency key.
4. Prove one task record, one Studio job, and one fake-provider submission.
5. Reject a cross-project request and a revoked Agent before provider I/O.
6. Map queued, running, progress, asset, success, and internal settlement events to a monotonic public stream.
7. Replay the public cursor, return the asset ID, and map the terminal A2A state to `completed`.
8. Scan every captured success/error response for test-only private values.

The CLI acceptance fixture starts the real `kortix executor mcp` stdio process, negotiates MCP revision `2025-11-25`, discovers the same strict wire contracts over HTTP, creates and replays a task, and confirms a revoked Agent does not create another row, job, or provider submission.

## Web Image Studio acceptance

The debug-only Web harness mounts the real Studio shell, Image Studio, and
Assets views with a fixed project and a test-only bootstrap token. Run it with
a local webpack server on an unused port:

```powershell
$env:E2E_BASE_URL='http://localhost:3300'; pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:image-studio
```

The fake provider is intercepted in the browser and never performs external
provider or object-storage I/O. The smoke requires project-scoped
`Authorization` headers, exact signed upload headers and bytes, estimate to
task provider/model/input equality, idempotent retry, event pagination, task
URL reload recovery, cancellation, 402/403 states, source/reuse links,
preview/download, desktop/mobile non-overlap and pixel checks, and redaction
of test tokens, estimate tokens, and signed URLs. It also fails on unexpected
`/v1/projects/*` scope requests and checks rendered cancelled multimedia
navigation entries. The accepted run on 2026-07-20 exited `0` and produced
inspected desktop/mobile screenshots under the ignored Web test-results directory.

This browser gate is evidence for the Web slice only. It does not enable
`STUDIO_ENABLED`, deploy a worker, prove a protected live provider, or prove
Alibaba OSS compatibility.

Run the focused acceptance fixtures:

```bash
pnpm --filter kortix-api exec bun test src/__tests__/e2e-intelligence-protocol.test.ts
pnpm --filter @kortix/cli exec bun test src/__tests__/e2e-intelligence-mcp.test.ts
```

## Additive AG-UI workflow replay

`INTELLIGENCE_AG_UI_ENABLED=false` is the default. When it remains disabled,
the AG-UI endpoint returns the stable
`INTELLIGENCE_AG_UI_DISABLED` response; existing workflow REST polling is
unchanged.

When explicitly enabled, the project-scoped endpoint is:

```text
GET /v1/projects/:projectId/intelligence/ag-ui/workflows/:runId/stream?cursor=:sequence
```

The stream requires the same project read authorization as workflow events. It
replays the durable workflow event sequence as SSE frames whose `id` values are
numeric sequences and whose `event` values are AG-UI event types. `cursor`
takes precedence; when it is absent, `Last-Event-ID` is accepted as the
numeric resume cursor. The bridge polls the existing workflow reader every
500ms, sends a `: keep-alive` comment every 15 seconds, and closes after a
terminal event receives one final flush.

The authenticated SDK stream reconnects from the most recently received event
ID. Consumers must retain REST cursor polling at
`/intelligence/workflows/:runId/events?cursor=:sequence` as the authoritative
fallback for disabled or unavailable streaming.

AG-UI is a one-way projection only: it is not stored as a workflow event or
used for orchestration. Public frames may contain stage summaries, approved
status/progress, stable codes, task/tool IDs, and asset IDs. They must not
contain prompts, payload references, credentials, provider or signed URLs, raw
provider bodies, headers, cookies, or reasoning text. Catalog search remains
read-only; for example:

```text
GET /v1/projects/:projectId/intelligence/catalog?query=image&limit=20
```

The MCP `tools/list` response remains a fixed meta-tool set. Catalog entries
are discovered through the existing capability tools and do not become dynamic
MCP tool definitions.

Run the focused AG-UI record before accepting this additive protocol slice:

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/ag-ui.test.ts src/schemas.test.ts
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter kortix-api exec bun test src/intelligence/capability-catalog.test.ts src/intelligence/ag-ui src/intelligence/project-routes.test.ts src/__tests__/e2e-intelligence-ag-ui.test.ts
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts src/core/stream/intelligence-ag-ui.test.ts src/react/use-intelligence.test.tsx
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter kortix-api typecheck
pnpm.cmd --filter @kortix/cli exec bun test src/__tests__/e2e-intelligence-mcp.test.ts
git diff --check
```

This record is not a production-readiness claim. It does not enable a
workflow runtime, provider, deployment, or any cancelled first-party video,
voice, 3D, digital-human, or batch-remix product.

## Redaction invariants

Public discovery exposes capability descriptors, provider configuration IDs, and non-sensitive model identifiers only. Agent Cards never contain credentials or provider connection details. Task responses contain task/job IDs and public state only. Events contain status, progress, stable error codes, and asset IDs; internal Studio cursors, object keys, raw provider bodies, credential material, billing reservation identifiers, and downloadable locations remain private.

Errors are fixed protocol envelopes. Do not interpolate an exception message, provider response, credential value, object key, or downloadable location into an API, A2A, MCP, log, issue, or operations transcript. Treat a redaction-scan failure as a release blocker.

## Complete protocol gate

Run all package and application gates before accepting the slice:

```bash
pnpm --filter @kortix/intelligence-contracts test
pnpm --filter @kortix/intelligence-contracts typecheck
pnpm --filter @kortix/registry test
pnpm --filter @kortix/registry typecheck
pnpm --filter @kortix/api-contract test
pnpm --filter @kortix/api-contract typecheck
pnpm --filter @kortix/db test
pnpm --filter @kortix/db typecheck
pnpm --filter kortix-api exec bun test src/intelligence src/studio/default-routes.test.ts src/__tests__/e2e-intelligence-protocol.test.ts src/__tests__/e2e-studio-production-api.test.ts
pnpm --filter kortix-api typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/cli test
pnpm --filter @kortix/cli typecheck
git diff --check
```

The explicit future-media boundary scan is:

```bash
rg "video.generate|voice.dialogue|voice.synthesize|voice.transcribe|model3d.generate|model3d.process|avatar.render|video.batch_mix|digital-human|batch-remix" apps packages tests -g "!**/node_modules/**"
```

Matches must be specifications, negative tests, or explicit non-goal documentation only. Any executable route, capability descriptor, registry seed, or navigation entry is a failed gate.

## Failure handling

On a protocol failure, preserve task/job IDs and stable error codes, disable only the affected test/provider configuration, and retain the event sequence for diagnosis. Do not copy raw provider output or private storage data into the incident record. Re-run the focused fixture after correction, then the complete protocol gate. Production rollout remains blocked until the separate provider/storage deployment and protected smoke requirements are satisfied.
