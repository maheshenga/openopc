# Milestone 0-1 Image Studio Implementation Plan

> **Execution:** Implement task-by-task with focused RED-GREEN tests and one reviewable commit per task. Do not use the `superpowers` skill family.

**Goal:** Freeze the real project progress and ship a usable Web Image Studio plus project Assets surface through the existing Intelligence SDK and Studio backend.

**Architecture:** Keep `kortix.project(projectId).intelligence` as the only product-facing client facade. Add typed SDK projections over the existing project-scoped Studio estimate, job, upload, and asset routes; do not add a second database, worker, route owner, or `project().studio` namespace. Web pages live under the existing authenticated project layout and use the shared SDK React Query hooks.

**Tech Stack:** TypeScript, existing `@kortix/api-contract` server contracts, dependency-light `@kortix/sdk` strict parsers, React 19, Next.js 15 App Router, TanStack Query 5, React Hook Form, Tailwind CSS 4, Lucide icons, Bun tests, Playwright.

## Global Constraints

- Kortix remains the sole base; all changes are additive extension work.
- First-party video, voice, 3D, digital-human, and batch-remix products remain cancelled.
- `STUDIO_ENABLED=false` and `INTELLIGENCE_WORKFLOWS_ENABLED=false` remain production defaults.
- API pods never claim Studio jobs; this plan does not modify worker ownership.
- Web code never calls project Studio or Intelligence API routes with ad hoc `fetch`.
- The only direct browser `fetch` allowed is a PUT to the short-lived signed object-storage URL returned by the SDK upload flow.
- Signed URLs, provider URLs, credentials, authorization headers, raw provider bodies, prompts, account IDs, project IDs, job IDs, and object keys never enter logs or telemetry labels.
- Public SDK changes are additive and must update runtime and type surface snapshots.
- Every code task starts with a focused failing test, proves the expected RED reason, implements the minimum behavior, then runs focused and package gates.
- Do not add disabled multimedia navigation, placeholder tabs, seed data, or capability descriptors.

---

### Task 1: Freeze Progress and Canonical Client Ownership

**Files:**
- Create: `docs/operations/studio-acceleration-progress.md`
- Modify: `packages/sdk/PROGRESS.md`
- Modify: `docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md`
- Modify: `apps/api/src/intelligence/workflows/operations-contract.test.ts`

**Interfaces:**
- Consumes: commit-backed implementation evidence through `bc74a4de2`.
- Produces: one authoritative progress ledger and a regression assertion that `project().intelligence` supersedes the unimplemented `project().studio` claim.

- [ ] **Step 1: Write the failing operations contract assertion**

Add this test to `operations-contract.test.ts`:

```ts
test('tracks Image Studio acceleration through the canonical Intelligence SDK', () => {
  const progress = source('docs/operations/studio-acceleration-progress.md');
  const sdkProgress = source('packages/sdk/PROGRESS.md');

  expect(progress).toContain('Milestone 0-1');
  expect(progress).toContain('kortix.project(projectId).intelligence');
  expect(progress).toContain('Web Image Studio');
  expect(sdkProgress).toContain('Superseded by the Intelligence SDK');
  expect(sdkProgress).not.toContain('- Status: active\n\n---\n\n## NOW');
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
pnpm.cmd --filter kortix-api exec bun test src/intelligence/workflows/operations-contract.test.ts
```

Expected: FAIL because `docs/operations/studio-acceleration-progress.md` does not exist.

- [ ] **Step 3: Write the progress ledger and retire the stale SDK claim**

The ledger must contain this status table:

```markdown
| Slice | State | Evidence | Next gate |
| --- | --- | --- | --- |
| Studio backend foundation | implemented | contracts, schema, billing, IAM, API, worker commits | protected production acceptance |
| Intelligence protocol | implemented | REST, SDK, MCP, A2A, task/event commits | retained regression gates |
| Intelligence workflows | implemented, disabled | workflow, approval, routing, evaluation, Temporal commits | separately reviewed production rollout |
| Milestone 0-1 | active | canonical Intelligence SDK decision | Web Image Studio browser acceptance |
| Mobile and Electron | planned | acceleration design Milestone 3 | separate plan |
| Developer Center | planned | acceleration design Milestone 4 | separate plan |
```

In `packages/sdk/PROGRESS.md`, change the 2026-07-15 Studio claim to `Status: superseded` and add `Superseded by the Intelligence SDK implemented at kortix.project(projectId).intelligence.` Do not mark the old `project().studio` facade complete.

At the top of the historical Phase 1 plan, add a note pointing to the new ledger and stating that unchecked historical procedure boxes are not current status evidence.

- [ ] **Step 4: Run GREEN and format checks**

```powershell
pnpm.cmd --filter kortix-api exec bun test src/intelligence/workflows/operations-contract.test.ts
git diff --check
```

Expected: all operations contract tests pass and `git diff --check` exits 0.

- [ ] **Step 5: Commit**

```powershell
git add docs/operations/studio-acceleration-progress.md packages/sdk/PROGRESS.md docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md apps/api/src/intelligence/workflows/operations-contract.test.ts
git commit -m "docs: freeze Image Studio acceleration progress"
```

---

### Task 2: Bind Signed Estimates to Intelligence Task Creation

**Files:**
- Modify: `packages/api-contract/src/intelligence.ts`
- Modify: `packages/api-contract/src/intelligence.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/intelligence.test.ts`
- Modify mechanically after GREEN: `packages/sdk/src/public-surface.snapshot.json`
- Modify mechanically after GREEN: `packages/sdk/src/public-type-surface.snapshot.json`
- Modify: `apps/api/src/intelligence/task-service.ts`
- Modify: `apps/api/src/intelligence/task-service.test.ts`
- Modify: `apps/api/src/intelligence/project-routes.ts`
- Modify: `apps/api/src/intelligence/project-routes.test.ts`
- Modify: `apps/api/src/intelligence/a2a.ts`
- Modify: `apps/api/src/intelligence/a2a.test.ts`
- Modify: `apps/api/src/intelligence/workflows/task-bridge.ts`
- Modify: `apps/api/src/intelligence/workflows/task-bridge.test.ts`
- Modify: `apps/api/src/studio/default-routes.ts`
- Modify: `apps/api/src/studio/default-routes.test.ts`

**Interfaces:**
- Consumes: Studio v2 estimate tokens issued by `POST /projects/:projectId/studio/estimates` and verified by `verifyStudioEstimateToken`.
- Produces an additive request field and a server-only execution policy:

```ts
export interface IntelligenceEstimateApproval {
  estimate_id: string;
  estimate_token: string;
  max_approved_credits: number;
}

export interface IntelligenceCreateTaskRequest {
  // Existing Intelligence v1 fields remain unchanged.
  estimate_approval?: IntelligenceEstimateApproval;
}

type IntelligenceEstimateMode = 'external_signed' | 'trusted_internal';
```

- [ ] **Step 1: Write RED contract and SDK tests**

Add a strict `IntelligenceEstimateApprovalSchema` with UUID `estimate_id`, a non-empty token capped at 8192 characters, and finite non-negative `max_approved_credits` capped at 1,000,000. Add it as optional to `IntelligenceCreateTaskRequestSchema` so Agent and workflow payload parsing remains backward compatible. SDK tests must prove the object is sent unchanged and unknown nested keys, non-finite limits, oversized tokens, and top-level extra keys are rejected by the API contract.

```powershell
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts
```

Expected: RED because `estimate_approval` is not part of either request type.

- [ ] **Step 2: Write RED estimate enforcement tests**

In `task-service.test.ts`, issue real v2 tokens with the existing helper and cover all of these cases before changing the bridge:

- a user task with a matching token creates a job using the signed estimate rather than a recalculated client value;
- a missing approval is rejected in `external_signed` mode;
- expired, tampered, cross-account, cross-project, cross-user, wrong-input-hash, wrong-estimate-ID, stale-provider, and stale-pricing approvals fail closed;
- `max_approved_credits` below the signed estimate maximum is rejected, while a larger caller limit never increases the persisted estimate;
- a same-input idempotency replay succeeds after token expiry and does not create a second job;
- `trusted_internal` creates from the server-resolved estimate without accepting a caller-selected price.

Use only stable public errors `INTELLIGENCE_ESTIMATE_INVALID` and `INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED`; error objects and route responses must not contain the token or token claims.

```powershell
pnpm.cmd --filter kortix-api exec bun test src/intelligence/task-service.test.ts src/intelligence/project-routes.test.ts src/intelligence/a2a.test.ts src/intelligence/workflows/task-bridge.test.ts
```

Expected: RED because the Intelligence bridge still creates `intelligence-internal` estimates for every actor.

- [ ] **Step 3: Implement signed approval verification without changing task semantics**

Add `estimateMode` to server-owned `IntelligenceTaskCreateInput`; it is not part of the wire request and cannot be caller-controlled. REST users receive `external_signed`. Agent and system identities derived from authenticated server context may receive `trusted_internal`; the server-side workflow task bridge passes `trusted_internal` explicitly and remains bounded by the workflow run credit approval.

For `external_signed`, `createStudioJobBridge` must:

1. verify the token signature and expiry;
2. compare account, project, actor user, estimate ID, and `studioRequestHash(request)` with the claims;
3. resolve the provider and pricing using the token's version binding;
4. verify the token again against the resolved binding;
5. require `approval.max_approved_credits >= claims.estimate.max_approved_credits`;
6. pass the signed estimate to `repository.createJob` without replacing costs from caller fields.

Keep the existing server-resolved estimate branch only for `trusted_internal`. Exclude `estimate_approval` and `idempotency_key` from `intelligenceTaskRequestHash`, because approval is authorization metadata rather than task semantics; keep provider, model, input, Agent Card hash, parent task, and deadline in the semantic hash. Perform idempotency replay lookup before token-expiry validation, matching the existing Studio job route.

Inject `config.API_KEY_SECRET` into `createStudioJobBridge` through `createDefaultIntelligenceProjectRoutes`; do not read process state inside the service and do not duplicate token parsing code from `estimate-token.ts`.

- [ ] **Step 4: Run GREEN and compatibility gates**

```powershell
pnpm.cmd --filter @kortix/api-contract exec bun test src/intelligence.test.ts
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence.test.ts
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter kortix-api exec bun test src/intelligence/task-service.test.ts src/intelligence/project-routes.test.ts src/intelligence/a2a.test.ts src/intelligence/workflows/task-bridge.test.ts src/studio/default-routes.test.ts
```

Expected: all focused tests pass; existing Agent/A2A and workflow tests prove their trusted server path still works without a public estimate token.

Regenerate only the intentional additive SDK declaration diff, inspect it, and rerun the SDK test:

```powershell
$env:UPDATE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-surface.test.ts; Remove-Item Env:UPDATE_SURFACE_SNAPSHOT
$env:UPDATE_TYPE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-type-surface.test.ts; Remove-Item Env:UPDATE_TYPE_SURFACE_SNAPSHOT
git diff -- packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json
pnpm.cmd --filter @kortix/sdk test
```

- [ ] **Step 5: Commit**

```powershell
git add packages/api-contract/src/intelligence.ts packages/api-contract/src/intelligence.test.ts packages/sdk/src/core/rest/projects-client/intelligence.ts packages/sdk/src/core/rest/projects-client/intelligence.test.ts packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json apps/api/src/intelligence apps/api/src/studio/default-routes.ts apps/api/src/studio/default-routes.test.ts
git commit -m "fix: bind Intelligence tasks to signed estimates"
```

---

### Task 3: Make Signed Uploads Browser-Safe

**Files:**
- Modify: `packages/api-contract/src/studio/index.ts`
- Modify: `packages/api-contract/src/studio/index.test.ts`
- Modify: `packages/studio-runtime/src/object-store.ts`
- Modify: `packages/studio-runtime/src/object-store.test.ts`
- Modify: `packages/studio-adapters/src/storage/s3-object-store.ts`
- Modify: `packages/studio-adapters/src/storage/s3-object-store.test.ts`
- Modify: `apps/api/src/studio/storage.ts`
- Modify: `apps/api/src/studio/storage.test.ts`

**Interfaces:**
- Produces a short-lived signed PUT request that a browser can execute exactly:

```ts
export interface StudioSignedUploadRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

export interface StudioUpload {
  signed_upload_url: string;
  signed_upload_headers: Readonly<Record<string, string>>;
}
```

- [ ] **Step 1: Write RED object-store and contract tests**

Require the signed-upload operation to return `{ url, headers }`. For S3, assert that `PutObjectCommand` omits `ContentLength`, while returned headers contain the exact browser-settable values bound by the signature: `content-type`, `x-amz-checksum-sha256`, `x-amz-meta-studio-checksum-sha256`, `x-amz-meta-studio-required-sse`, optional `x-amz-meta-studio-required-kms-key-id`, `x-amz-server-side-encryption`, optional `x-amz-server-side-encryption-aws-kms-key-id`, and optional `x-amz-expected-bucket-owner`. Assert the browser header record never contains `content-length`, `authorization`, `cookie`, `host`, CR/LF, more than 16 entries, a name outside lowercase HTTP token syntax, or a value longer than 2048 characters.

```powershell
pnpm.cmd --filter @kortix/api-contract exec bun test src/studio/index.test.ts
pnpm.cmd --filter @kortix/studio-runtime exec bun test src/object-store.test.ts
pnpm.cmd --filter @kortix/studio-adapters exec bun test src/storage/s3-object-store.test.ts
```

Expected: RED because the port returns only a URL and the S3 command binds `ContentLength`.

- [ ] **Step 2: Implement the browser-safe presigned request**

Change the object-store signed-upload return type atomically in the in-memory and S3 adapters. Remove `ContentLength` only from the presigned `PutObjectCommand`; browsers set that forbidden header themselves. Keep expected size in the pending upload record, and retain the existing finalization checks against `HeadObject.ContentLength` and checksum before accepting the asset.

Build one canonical lowercase header record from the same command inputs used for signing. Mark every returned `x-amz-*` header unhoistable in the presigner so the URL and returned headers cannot disagree. `content-type` remains in `signableHeaders`. Do not return signing credentials, authorization, cookies, object-store clients, raw SDK commands, or headers already carried by the signed query string.

- [ ] **Step 3: Expose and validate the additive response field**

Add `signed_upload_headers` to `StudioUploadSchema`. `StudioStorageService.createUpload` returns the URL and a cloned, validated header record but persists neither. Tests must prove storage finalization still rejects actual size/checksum mismatches and that logs and telemetry contain neither URL nor headers.

```powershell
pnpm.cmd --filter kortix-api exec bun test src/studio/storage.test.ts
```

Expected: GREEN only after the route response and persistence boundary are updated together.

- [ ] **Step 4: Run package gates and commit**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter @kortix/studio-runtime test
pnpm.cmd --filter @kortix/studio-runtime typecheck
pnpm.cmd --filter @kortix/studio-adapters test
pnpm.cmd --filter @kortix/studio-adapters typecheck
pnpm.cmd --filter kortix-api exec bun test src/studio/storage.test.ts
git diff --check
git add packages/api-contract/src/studio packages/studio-runtime/src/object-store.ts packages/studio-runtime/src/object-store.test.ts packages/studio-adapters/src/storage apps/api/src/studio/storage.ts apps/api/src/studio/storage.test.ts
git commit -m "fix: make Studio signed uploads browser-safe"
```

---

### Task 4: Add Typed Image, Job, Upload, and Asset SDK Projections

**Files:**
- Create: `packages/sdk/src/core/rest/projects-client/intelligence-studio.ts`
- Create: `packages/sdk/src/core/rest/projects-client/intelligence-studio.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Modify: `packages/sdk/src/core/client/kortix.ts`
- Modify: `packages/sdk/src/core/client/kortix.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify mechanically after GREEN: `packages/sdk/src/public-surface.snapshot.json`
- Modify mechanically after GREEN: `packages/sdk/src/public-type-surface.snapshot.json`

**Interfaces:**
- Consumes: existing `/projects/:projectId/studio/*` routes plus the Task 3 upload response.
- Produces public `IntelligenceImageEstimateRequest`, `IntelligenceImageEstimate`, `IntelligenceStudioJob`, `IntelligenceStudioUpload`, `IntelligenceStudioAsset`, `IntelligenceAssetDownload`, and paginated result interfaces plus these methods under the canonical facade:

```ts
kortix.project(projectId).intelligence.image.estimate(input)
kortix.project(projectId).intelligence.jobs.list(cursor?)
kortix.project(projectId).intelligence.jobs.get(jobId)
kortix.project(projectId).intelligence.jobs.events(jobId, cursor?)
kortix.project(projectId).intelligence.jobs.cancel(jobId)
kortix.project(projectId).intelligence.uploads.create(input)
kortix.project(projectId).intelligence.uploads.finalize(uploadId)
kortix.project(projectId).intelligence.assets.list(cursor?)
kortix.project(projectId).intelligence.assets.get(assetId)
kortix.project(projectId).intelligence.assets.downloadUrl(assetId)
```

- [ ] **Step 1: Write RED REST tests**

Configure the existing fake backend and assert the exact methods and project-scoped paths for estimate, job list/get/events/cancel, upload create/finalize, asset list/get, and asset download URL. Also assert malformed UUIDs, extra response keys, cross-project assets, unsafe upload header names/values, and signed URLs using a scheme other than HTTPS or loopback HTTP are rejected before returning data to consumers.

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence-studio.test.ts
```

Expected: RED because the projection module does not exist.

- [ ] **Step 2: Implement dependency-light strict projections**

Do not add `@kortix/api-contract` or Zod as SDK dependencies: `@kortix/api-contract` is private and cannot leak into published SDK declarations. Define public request/response interfaces in `intelligence-studio.ts`, use `backendApi`, and follow `intelligence.ts` with strict record, UUID, cursor, number, state, asset, upload-header, and signed-URL parsers. The download response parser accepts only:

```ts
export interface IntelligenceAssetDownload {
  asset_id: string;
  signed_download_url: string;
  expires_at: string;
}
```

`parseSignedUrl` accepts `https:` everywhere and `http:` only for `localhost`, `127.0.0.0/8`, or `[::1]`. Use `encodeURIComponent` for every project, job, upload, asset, and cursor value. Never include parsed bodies, headers, or signed URLs in thrown error messages.

- [ ] **Step 3: Add facade methods and public exports**

Extend the existing `intelligence` object in `kortix.ts` with `image`, `jobs`, `uploads`, and `assets`. Re-export functions and types through `projects-client/index.ts` and the SDK root. Do not add a package export or `project().studio` property. Add a facade test that calls every subgroup and asserts every request starts with `/projects/PID123/studio/`.

- [ ] **Step 4: Run GREEN and update snapshots**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/core/rest/projects-client/intelligence-studio.test.ts src/core/client/kortix.test.ts
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk build:bundles
```

If public-surface tests report the intentional additive diff, regenerate, inspect, and rerun the gates:

```powershell
$env:UPDATE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-surface.test.ts; Remove-Item Env:UPDATE_SURFACE_SNAPSHOT
$env:UPDATE_TYPE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-type-surface.test.ts; Remove-Item Env:UPDATE_TYPE_SURFACE_SNAPSHOT
git diff -- packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json
```

- [ ] **Step 5: Commit**

```powershell
git add packages/sdk
git commit -m "feat: project Studio operations through Intelligence SDK"
```

---

### Task 5: Add React Query Hooks for Image Studio

**Files:**
- Modify: `packages/sdk/src/react/use-intelligence.ts`
- Modify: `packages/sdk/src/react/use-intelligence.test.tsx`
- Modify: `packages/sdk/src/react/index.ts`
- Modify mechanically: SDK public surface snapshots

**Interfaces:**
- Consumes: Task 4 SDK functions.
- Produces:

```ts
intelligenceJobsKey(projectId, cursor?)
intelligenceAssetsKey(projectId, cursor?)
useIntelligenceJobs(projectId, cursor?, options?)
useIntelligenceAssets(projectId, cursor?, options?)
useEstimateIntelligenceImage(projectId)
useCancelIntelligenceJob(projectId)
useCreateIntelligenceUpload(projectId)
useFinalizeIntelligenceUpload(projectId)
useIntelligenceAssetDownload(projectId)
```

- [ ] **Step 1: Write RED hook tests**

Add tests proving disabled queries make no request, cursor keys are stable, successful cancellation invalidates job/event keys, finalized upload invalidates assets, and download mutation does not place signed URLs in the Query cache.

```ts
test('finalizing an upload invalidates only project Intelligence asset data', async () => {
  const mutation = asMockQueryConfig(useFinalizeIntelligenceUpload(PROJECT_ID));
  mutation.onSuccess?.();
  expect(invalidated).toContainEqual([...intelligenceAssetsPrefix(PROJECT_ID)]);
  expect(invalidated).not.toContainEqual(['project-sessions', PROJECT_ID]);
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/react/use-intelligence.test.tsx
```

Expected: FAIL because the hooks and keys are missing.

- [ ] **Step 3: Implement hooks and scoped invalidation**

Use `useQuery` for jobs/assets and `useMutation` for estimate, cancel, upload creation/finalization, and download URL creation. Preserve project-scoped invalidation and never invalidate session/runtime caches.

Export the new hooks and keys from `packages/sdk/src/react/index.ts` without a new subpath.

- [ ] **Step 4: Run GREEN**

```powershell
pnpm.cmd --filter @kortix/sdk exec bun test src/react/use-intelligence.test.tsx
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
```

Regenerate the intentional hook export snapshots, inspect them, and rerun the package test:

```powershell
$env:UPDATE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-surface.test.ts; Remove-Item Env:UPDATE_SURFACE_SNAPSHOT
$env:UPDATE_TYPE_SURFACE_SNAPSHOT='1'; pnpm.cmd --filter @kortix/sdk exec bun test src/public-type-surface.test.ts; Remove-Item Env:UPDATE_TYPE_SURFACE_SNAPSHOT
git diff -- packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json
pnpm.cmd --filter @kortix/sdk test
```

- [ ] **Step 5: Commit**

```powershell
git add packages/sdk/src/react packages/sdk/src/public-surface.snapshot.json packages/sdk/src/public-type-surface.snapshot.json
git commit -m "feat: add Image Studio SDK hooks"
```

---

### Task 6: Add Headless Image Studio State and Reference Upload

**Files:**
- Create: `apps/web/src/features/studio/image-input.ts`
- Create: `apps/web/src/features/studio/image-input.test.ts`
- Create: `apps/web/src/features/studio/task-state.ts`
- Create: `apps/web/src/features/studio/task-state.test.ts`
- Create: `apps/web/src/features/studio/reference-upload.ts`
- Create: `apps/web/src/features/studio/reference-upload.test.ts`

**Interfaces:**
- Produces:

```ts
buildImageTaskRequest(
  input: IntelligenceImageFormState,
  approval: IntelligenceEstimateApproval,
): IntelligenceCreateTaskRequest
selectImageExecutionTarget(discovery, selection): IntelligenceExecutionTarget | null
reduceTaskEvents(events): ImageTaskViewState
uploadReferenceImage(input): Promise<IntelligenceStudioAsset>
```

- [ ] **Step 1: Write RED pure-state tests**

Test prompt trimming, output count 1-8, stable idempotency reuse, provider/model selection, exact estimate-approval forwarding, terminal event reduction, asset ID deduplication, cursor progression, and safe error-code mapping. Add a pure form controller that clears its cached estimate whenever any estimate-relevant field changes; only a cached estimate associated with the current normalized form snapshot can be converted into `IntelligenceEstimateApproval`.

```ts
test('reduces replayed events into one terminal result set', () => {
  expect(reduceTaskEvents([created, running, assetOne, assetOne, succeeded])).toMatchObject({
    status: 'succeeded',
    progress: 1,
    assetIds: [ASSET_ID],
    terminal: true,
  });
});
```

- [ ] **Step 2: Write RED upload tests**

Inject SDK operations and `fetch` into `uploadReferenceImage`. Assert SHA-256 is calculated before upload creation, the signed URL receives one PUT with exact bytes and the complete `signed_upload_headers` record unchanged, no extra `content-length` or authorization header is added, finalize is called only after a 2xx PUT, and failed PUTs never finalize or log the URL or headers.

- [ ] **Step 3: Run RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/image-input.test.ts src/features/studio/task-state.test.ts src/features/studio/reference-upload.test.ts
```

Expected: FAIL because the feature files do not exist.

- [ ] **Step 4: Implement the pure state and upload helper**

Keep these modules free of React and DOM rendering. `uploadReferenceImage` accepts a `File`-compatible object, validates `image/png`, `image/jpeg`, or `image/webp`, limits the file to the server contract, computes a lowercase SHA-256 hex digest with `crypto.subtle`, performs the signed PUT with `headers: upload.signed_upload_headers`, and returns the finalized asset.

- [ ] **Step 5: Run GREEN**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/image-input.test.ts src/features/studio/task-state.test.ts src/features/studio/reference-upload.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/features/studio
git commit -m "feat: add Image Studio client state"
```

---

### Task 7: Add Project Studio Routes, Shell, and Navigation

**Files:**
- Create: `apps/web/src/app/(app)/projects/[id]/studio/image/page.tsx`
- Create: `apps/web/src/app/(app)/projects/[id]/studio/assets/page.tsx`
- Create: `apps/web/src/features/studio/studio-shell.tsx`
- Create: `apps/web/src/features/studio/studio-shell.test.tsx`
- Create: `apps/web/src/features/workspace/project-sidebar/footer/project-studio-nav.tsx`
- Create: `apps/web/src/features/workspace/project-sidebar/footer/project-studio-nav.test.tsx`
- Modify: `apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx`
- Modify: `apps/web/translations/en.json`
- Modify: `apps/web/translations/de.json`
- Modify: `apps/web/translations/es.json`
- Modify: `apps/web/translations/fr.json`
- Modify: `apps/web/translations/it.json`
- Modify: `apps/web/translations/ja.json`
- Modify: `apps/web/translations/pt.json`
- Modify: `apps/web/translations/zh.json`

**Interfaces:**
- Consumes: `useIntelligenceCapabilityDiscovery`.
- Produces: `/projects/:id/studio/image` and `/projects/:id/studio/assets` inside `ProjectShell`.

- [ ] **Step 1: Write RED shell and navigation tests**

Export pure view components that accept already-resolved discovery state, then use `renderToStaticMarkup` as existing Web component tests do. Assert only Image Studio and Assets links exist, the active route is indicated, and the entire nav entry is absent when discovery has no executable `studio.image.generate` target.

```ts
test('does not render a disabled Studio placeholder', () => {
  const html = renderProjectStudioNav({ projectId: PROJECT_ID, targets: [] });
  expect(html).not.toContain('Image Studio');
  expect(html).not.toContain('/studio/video');
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/studio-shell.test.tsx src/features/workspace/project-sidebar/footer/project-studio-nav.test.tsx
```

- [ ] **Step 3: Implement the routes and compact shell**

Each route reads `id` with `useParams`, renders `ProjectShell`, then renders `StudioShell`. The shell uses an unframed full-height layout with a 44px header, `Image` and `Images` Lucide icons, text links for the two clear destinations, and no multimedia placeholders.

Add `ProjectStudioNavItem` immediately above `ProjectFilesNavItem` in the project sidebar. Close the mobile sidebar on navigation using `useSidebar().setOpenMobile(false)`, matching the project sidebar. Add an identical `studio` namespace to all eight translation files with keys for Image Studio, Assets, loading, unavailable, navigation labels, and accessibility labels; English and Chinese receive native copy, and the other locale files receive reviewed English fallback copy so the translation key audit remains complete.

- [ ] **Step 4: Run GREEN and route build**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/studio-shell.test.tsx src/features/workspace/project-sidebar/footer/project-studio-nav.test.tsx
pnpm.cmd --filter Kortix-Computer-Frontend build
```

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/app/'(app)'/projects/'[id]'/studio apps/web/src/features/studio/studio-shell.tsx apps/web/src/features/studio/studio-shell.test.tsx apps/web/src/features/workspace/project-sidebar apps/web/translations
git commit -m "feat: add project Image Studio routes"
```

---

### Task 8: Build the Image Studio Work Surface

**Files:**
- Create: `apps/web/src/features/studio/image-studio-page.tsx`
- Create: `apps/web/src/features/studio/image-studio-page.test.tsx`
- Create: `apps/web/src/features/studio/image-generation-form.tsx`
- Create: `apps/web/src/features/studio/image-task-results.tsx`
- Modify: `apps/web/src/app/(app)/projects/[id]/studio/image/page.tsx`
- Modify: `apps/web/translations/en.json`
- Modify: `apps/web/translations/de.json`
- Modify: `apps/web/translations/es.json`
- Modify: `apps/web/translations/fr.json`
- Modify: `apps/web/translations/it.json`
- Modify: `apps/web/translations/ja.json`
- Modify: `apps/web/translations/pt.json`
- Modify: `apps/web/translations/zh.json`

**Interfaces:**
- Consumes: Tasks 2-6 estimate binding, upload contract, SDK hooks, and headless state.
- Produces: complete prompt-to-assets web flow.

- [ ] **Step 1: Write RED component contract tests**

Export a pure `ImageStudioView` that accepts resolved state and callbacks. Test its static markup with `renderToStaticMarkup`; test submit/cancel/reuse event wiring as pure controller functions, and reserve real click/type behavior for Task 10 Playwright. Cover these states independently:

- discovery loading and unavailable;
- provider/model selection;
- prompt validation and output count bounds;
- estimate display;
- insufficient credits and permission denial;
- idempotent submit disabled while pending;
- queued/running/progress/unknown/failed/cancelled/succeeded;
- reload recovery from task ID stored in the route query string;
- result preview, download, and reuse-as-reference actions.

```ts
test('submits the canonical Intelligence image task', async () => {
  const request = buildImageTaskRequest(validFormState, signedEstimateApproval);
  expect(request).toMatchObject({
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    estimate_approval: signedEstimateApproval,
    input: { capability: 'image.generate' },
  });
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/image-studio-page.test.tsx
```

- [ ] **Step 3: Implement the professional work surface**

Desktop layout uses a stable `minmax(320px, 380px) minmax(0, 1fr)` grid; mobile stacks the form above results. The form is an unframed panel with prompt, optional negative prompt, provider/model selects, aspect-ratio segmented control, quality segmented control, output-count stepper, reference thumbnails, estimated credits, and one Generate command.

The results area uses fixed aspect-ratio tiles and never resizes the toolbar. Use Lucide icon buttons with tooltips for download, reuse reference, and cancel. Do not nest cards. Error states show the stable error code and a retry command without provider bodies or URLs. Add every new visible string and accessibility label to the shared `studio` translation namespace in all eight locales; no new component uses the legacy generated `hardcodedUi` namespace.

Persist only `task` in the URL query string. Resume event polling from the last durable cursor in component state; stop polling on terminal status. Reusing an output adds the asset ID to the form without downloading and re-uploading it.

Estimate whenever the normalized valid form changes, but keep the returned token only in component memory. A later form change clears it. Clicking Generate converts the current estimate into `{ estimate_id, estimate_token, max_approved_credits }`; a 409 estimate error refreshes the displayed estimate and requires another user command rather than automatically resubmitting at a changed cost.

- [ ] **Step 4: Run GREEN and web gates**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/image-studio-page.test.tsx src/features/studio/image-input.test.ts src/features/studio/task-state.test.ts src/features/studio/reference-upload.test.ts
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
pnpm.cmd --filter Kortix-Computer-Frontend build
```

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/features/studio apps/web/src/app/'(app)'/projects/'[id]'/studio/image apps/web/translations
git commit -m "feat: build Web Image Studio"
```

---

### Task 9: Build the Project Assets Surface

**Files:**
- Create: `apps/web/src/features/studio/assets-page.tsx`
- Create: `apps/web/src/features/studio/assets-page.test.tsx`
- Create: `apps/web/src/features/studio/asset-preview-dialog.tsx`
- Modify: `apps/web/src/app/(app)/projects/[id]/studio/assets/page.tsx`
- Modify: all eight `apps/web/translations/*.json` files under the shared `studio` namespace

**Interfaces:**
- Consumes: `useIntelligenceAssets`, asset download mutation, and Image Studio reuse route.
- Produces: project-owned image browsing, preview, download, source job navigation, and reuse.

- [ ] **Step 1: Write RED Assets tests**

Test the pure view with `renderToStaticMarkup`. Assert loading, empty, error, cursor pagination, MIME filter, stable grid dimensions, preview dialog, source job link, and reuse navigation to `/studio/image?reference=<assetId>`. Test the download-on-command behavior in an exported controller function and again through Playwright in Task 10.

```ts
test('does not request a signed URL until download is invoked', async () => {
  const controller = createAssetDownloadController({ createDownloadUrl, openUrl });
  expect(createDownloadUrl).not.toHaveBeenCalled();
  await controller.download(asset.asset_id);
  expect(createDownloadUrl).toHaveBeenCalledWith(asset.asset_id);
});
```

- [ ] **Step 2: Run RED**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/assets-page.test.tsx
```

- [ ] **Step 3: Implement Assets**

Use an unframed toolbar with kind and source filters, followed by a responsive grid with stable `aspect-ratio`. Preview uses the short-lived URL only in memory and clears it when the dialog closes. Do not store signed URLs in local storage, query keys, logs, or analytics.

Reuse navigates with an asset ID, and Image Studio validates the referenced project asset through the existing server path before provider submission.

- [ ] **Step 4: Run GREEN and build**

```powershell
pnpm.cmd --filter Kortix-Computer-Frontend exec bun test src/features/studio/assets-page.test.tsx src/features/studio/image-studio-page.test.tsx
pnpm.cmd --filter Kortix-Computer-Frontend build
```

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/features/studio apps/web/src/app/'(app)'/projects/'[id]'/studio/assets apps/web/translations
git commit -m "feat: add project Studio assets"
```

---

### Task 10: Add Browser Acceptance and Visual Verification

**Files:**
- Create: `apps/web/src/app/(system)/debug/image-studio/page.tsx`
- Create: `apps/web/scripts/e2e/image-studio-smoke.ts`
- Modify: `apps/web/package.json`
- Modify: `tests/spec/end-to-end.md`

**Interfaces:**
- Consumes: completed Web Image Studio, Assets page, `setBootstrapAuthToken`, and mockable API boundaries.
- Produces: repeatable desktop/mobile browser acceptance with screenshots and request assertions.

- [ ] **Step 1: Write the failing Playwright smoke**

Create `/debug/image-studio` using the existing system debug-harness pattern. On mount it calls `setBootstrapAuthToken('debug-image-studio-token')`, clears the token on unmount, and renders the real `StudioShell`, `ImageStudioPage`, and `AssetsPage` against fixed UUID project data. A local view selector switches between Image Studio and Assets without requiring a live Supabase session; production routes and auth behavior remain unchanged.

The script must intercept capability discovery, Agent Card, estimate, task creation, task event pages, upload creation/finalization, asset list/get, and download URL requests. Every API request must contain `Authorization: Bearer debug-image-studio-token`. The task assertion must prove `estimate_approval.estimate_id`, token, and limit match the mocked estimate, while the semantic provider/model/input match the estimate request. Assert idempotency replay behavior and absence of cancelled multimedia navigation.

Run against desktop `1440x1000` and mobile `390x844`. Save screenshots to `apps/web/test-results/image-studio-desktop.png` and `apps/web/test-results/image-studio-mobile.png`.

- [ ] **Step 2: Run RED against the local web server**

Terminal 1:

```powershell
$env:WEB_PORT='3300'; pnpm.cmd --filter Kortix-Computer-Frontend dev
```

Terminal 2:

```powershell
$env:E2E_BASE_URL='http://localhost:3300'; pnpm.cmd --filter Kortix-Computer-Frontend exec bun scripts/e2e/image-studio-smoke.ts
```

Expected: FAIL because `/debug/image-studio` does not exist. After the harness exists, keep one assertion for the not-yet-added `data-testid="image-studio-accepted"`, observe RED, then add that marker to the real work surface.

- [ ] **Step 3: Complete the smoke and package script**

Add `test:e2e:image-studio` to `apps/web/package.json`. The smoke must exercise prompt entry, estimate, signed estimate submission, generate, progress, output render, reuse reference, reload recovery, cancellation, insufficient credits, permission denial, reference upload with the exact signed header record, Assets navigation, preview, and download.

Use pixel checks to reject blank screenshots and DOM bounding-box assertions to reject overlapping form, toolbar, and result grid at both viewports.

- [ ] **Step 4: Run GREEN and inspect screenshots**

```powershell
$env:E2E_BASE_URL='http://localhost:3300'; pnpm.cmd --filter Kortix-Computer-Frontend test:e2e:image-studio
```

Open both screenshots and confirm text fits, controls do not overlap, the generated image grid is visible, and the mobile page remains usable without horizontal scrolling.

- [ ] **Step 5: Update accepted flow and commit**

Document the exact command and fake-provider request flow in `tests/spec/end-to-end.md`.

```powershell
git add apps/web/src/app/'(system)'/debug/image-studio/page.tsx apps/web/scripts/e2e/image-studio-smoke.ts apps/web/package.json tests/spec/end-to-end.md
git commit -m "test: gate Web Image Studio flow"
```

Do not commit generated screenshots unless the repository's existing E2E policy explicitly tracks them.

---

### Task 11: Run Milestone 0-1 Acceptance and Close the Ledger

**Files:**
- Modify: `docs/operations/studio-acceleration-progress.md`
- Modify: `docs/operations/intelligence-fabric.md`
- Modify: `docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md`
- Modify: `.github/workflows/ci.yml` only if current path filters do not already include every new SDK/Web file

**Interfaces:**
- Produces: recorded Milestone 0-1 completion evidence without production enablement.

- [ ] **Step 1: Run focused package gates**

```powershell
pnpm.cmd --filter @kortix/api-contract test
pnpm.cmd --filter @kortix/api-contract typecheck
pnpm.cmd --filter @kortix/studio-runtime test
pnpm.cmd --filter @kortix/studio-runtime typecheck
pnpm.cmd --filter @kortix/studio-adapters test
pnpm.cmd --filter @kortix/studio-adapters typecheck
pnpm.cmd --filter @kortix/sdk test
pnpm.cmd --filter @kortix/sdk typecheck
pnpm.cmd --filter @kortix/sdk build:bundles
pnpm.cmd --filter Kortix-Computer-Frontend test
pnpm.cmd --filter Kortix-Computer-Frontend i18n:audit
pnpm.cmd --filter Kortix-Computer-Frontend build
pnpm.cmd --filter kortix-api exec bun test src/intelligence/task-service.test.ts src/intelligence/project-routes.test.ts src/intelligence/a2a.test.ts src/intelligence/workflows/task-bridge.test.ts src/intelligence/workflows/operations-contract.test.ts src/studio/estimate-token.test.ts src/studio/estimates.test.ts src/studio/storage.test.ts
```

- [ ] **Step 2: Run browser acceptance**

Start the local web server on an unused port, run `test:e2e:image-studio`, and inspect both screenshots. Record the port and exit results in the progress ledger; do not record tokens, URLs containing signed queries, or response bodies.

- [ ] **Step 3: Run absence and maintenance scans**

```powershell
rg -n --glob '!**/*.test.*' --glob '!**/*.spec.*' -e '/studio/video' -e '/studio/voice' -e '/studio/3d' -e '/studio/digital-human' -e '/studio/batch-remix' apps packages
rg -n -e 'project\(.*\)\.studio' packages/sdk apps/web
git diff --check
```

Expected: the multimedia scan and legacy SDK-facade scan return no runtime matches; `git diff --check` exits 0.

- [ ] **Step 4: Close only Milestone 0-1**

Mark the ledger row `Milestone 0-1` complete with commit hashes and exact verification commands. Update the historical plan note to point at the ledger. Do not mark mobile, Electron, deployment, protected live-provider/OSS, Developer Center, revenue, trust, or provenance complete.

- [ ] **Step 5: Review and commit**

```powershell
git status --short
git diff --check
git add docs/operations/studio-acceleration-progress.md docs/operations/intelligence-fabric.md docs/specs/2026-07-15-kortix-studio-phase1-implementation-plan.md .github/workflows/ci.yml
git diff --cached --check
git commit -m "docs: close Image Studio web milestone"
```

Stage `.github/workflows/ci.yml` only if it changed.

## Milestone Completion Checklist

- [ ] Progress state is commit-backed and the stale `project().studio` claim is retired.
- [ ] User-originated Intelligence image tasks are bound to signed, version-checked estimates; trusted internal execution remains server-only.
- [ ] Browser signed uploads use an exact safe header contract, do not bind caller-set `Content-Length`, and still verify final size and checksum.
- [ ] `kortix.project(projectId).intelligence` exposes image estimate, jobs, uploads, and assets without a new SDK subpath.
- [ ] Web Image Studio supports estimate, idempotent generation, progress, cancellation, reload recovery, output preview, download, and reuse.
- [ ] Assets supports project-scoped listing, preview, download, source navigation, and reuse.
- [ ] Sidebar navigation appears only when `studio.image.generate` is executable.
- [ ] Desktop and mobile browser acceptance passes with nonblank, nonoverlapping screenshots.
- [ ] SDK public surfaces remain additive and package snapshots pass.
- [ ] No cancelled first-party multimedia route, capability, or placeholder is introduced.
- [ ] Production feature flags remain disabled and no production readiness claim is made.
