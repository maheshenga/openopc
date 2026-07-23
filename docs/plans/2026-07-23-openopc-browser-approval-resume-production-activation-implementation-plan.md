# OpenOPC Browser Approval Resume Production Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely compose the existing Browser Approval Resume primitives into the OpenOPC Control and Browser Worker production entrypoints while remaining default-disabled and fail-closed.

**Architecture:** Keep `main.ts` files thin and put lifecycle ownership in independently tested production-runtime modules. Control reuses one authenticated Worker security context, one managed WSS connection, and the existing composite poller; Worker accepts only authenticated dispatches and resolves every execution dependency through real authority, event, isolation, and private-object-storage bindings.

**Tech Stack:** TypeScript, Bun 1.3, Hono, Zod, Drizzle ORM/PostgreSQL, Redis, Playwright, AWS S3-compatible Studio storage, Docker, Biome, pnpm workspaces.

**Design reference:** `docs/specs/2026-07-23-openopc-browser-approval-resume-production-activation-design.md`

## Global Constraints

- Product-facing name is OpenOPC; existing `@kortix/*` package names remain unchanged for upstream compatibility.
- Do not modify Kortix IAM, Agent, Workflow, Billing, Registry, Orchestration, or public approval API semantics.
- `AUTOMATION_CONTROL_ENABLED`, `AUTOMATION_BROWSER_HEARTBEAT_ENABLED`, `AUTOMATION_BROWSER_DISPATCH_ENABLED`, and `AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED` remain `false` by default.
- A partial activation chain is a startup configuration error; it must never downgrade to unapproved execution.
- Raw Resume tokens, token hashes, peppers, shared secrets, certificate bodies, signatures, and signed URLs must not enter logs, responses, metrics, or events.
- Use one existing coordinator poller; do not add another scheduler, queue, or sidecar.
- Preserve direct `bun run src/worker.ts` fail-closed behavior.
- Web and desktop remain the active client priorities; Android and iOS remain deferred.
- Do not edit or commit `docs/plans/2026-07-21-openopc-milestone-a-implementation-plan.md` or `docs/specs/2026-07-21-openopc-frontier-ai-technology-selection.md`.
- Do not bulk-format `packages/db/src/index.ts` or `packages/db/src/schema/kortix.ts`; run Biome only on files changed by this plan.
- Run focused tests first, then Docker smoke checks, then the restored full repository regression.
- Do not claim real PostgreSQL multi-connection concurrency, real Browser E2E, or deployment evidence in this phase.

## File Map

### Contracts

- Modify `packages/intelligence-contracts/src/automation.ts`: versioned internal Browser authority-check path and schemas.
- Modify `packages/intelligence-contracts/src/automation.test.ts`: strict parsing, binding, and secret-rejection tests.

### Automation Control

- Modify `apps/automation-control/src/config.ts`: dedicated signing identity, dispatch secret, and Resume token pepper.
- Modify `apps/automation-control/src/dispatch/worker-auth.ts`: outbound signer separated from inbound peer verification.
- Create `apps/automation-control/src/dispatch/worker-auth-signer.test.ts`: signer/verifier separation tests.
- Create `apps/automation-control/src/dispatch/browser-authority-store.ts`: current lease/action/cursor/full-access authority checks.
- Create `apps/automation-control/src/dispatch/browser-authority-store.test.ts`: pure authority and PostgreSQL-adapter tests.
- Create `apps/automation-control/src/dispatch/browser-authority-route.ts`: authenticated internal authority route.
- Create `apps/automation-control/src/dispatch/browser-authority-route.test.ts`: mTLS, proof, replay, redaction, and error mapping tests.
- Create `apps/automation-control/src/dispatch/worker-security-runtime.ts`: one Redis replay store, verifier, and local signer.
- Create `apps/automation-control/src/dispatch/browser-worker-routes.ts`: heartbeat, authority, and consume route composition.
- Create `apps/automation-control/src/dispatch/browser-worker-routes.test.ts`: gate and shared-auth tests.
- Modify `apps/automation-control/src/dispatch/heartbeat-runtime.ts`: accept the shared verifier instead of constructing another one.
- Modify `apps/automation-control/src/dispatch/browser-worker-connection.ts`: observable connection state.
- Create `apps/automation-control/src/dispatch/managed-browser-worker-connection.ts`: bounded reconnect and unusable-connection replacement.
- Create `apps/automation-control/src/dispatch/managed-browser-worker-connection.test.ts`: readiness, backoff, and unknown-result tests.
- Create `apps/automation-control/src/production-runtime.ts`: complete Control composition and lifecycle.
- Create `apps/automation-control/src/production-runtime.test.ts`: default-disabled, enabled, readiness, and shutdown tests.
- Modify `apps/automation-control/src/server.ts`: Browser runtime readiness dependency.
- Modify `apps/automation-control/src/server.test.ts`: readiness and redaction assertions.
- Modify `apps/automation-control/src/main.ts`: thin bootstrap only.

### Browser Worker and Storage

- Modify `packages/studio-adapters/src/config.ts`: parse S3 storage independently from AI provider activation.
- Modify `packages/studio-adapters/src/config.test.ts`: independent S3 parsing tests.
- Modify `apps/automation-browser-worker/package.json`: add Studio storage workspace dependencies and point `start` to `main.ts`.
- Modify `apps/automation-browser-worker/src/config.ts`: production evidence configuration and strict gate dependencies.
- Create `apps/automation-browser-worker/src/evidence-store.ts`: private S3-backed `EvidenceStore` adapter.
- Create `apps/automation-browser-worker/src/evidence-store.test.ts`: key binding, checksum, metadata, and no-URL tests.
- Modify `apps/automation-browser-worker/src/heartbeat-client.ts`: serial authenticated event emission in addition to periodic heartbeat.
- Modify `apps/automation-browser-worker/src/heartbeat-client.test.ts`: event ordering, response binding, and failure tests.
- Create `apps/automation-browser-worker/src/authority-client.ts`: signed mTLS authority client.
- Create `apps/automation-browser-worker/src/authority-client.test.ts`: binding, response, timeout, and redaction tests.
- Create `apps/automation-browser-worker/src/runtime-isolation.ts`: local non-root/container-limit attestation.
- Create `apps/automation-browser-worker/src/runtime-isolation.test.ts`: fail-closed probe tests.
- Create `apps/automation-browser-worker/src/execution-bindings.ts`: map verified work items to `runBrowserWorker` dependencies.
- Create `apps/automation-browser-worker/src/execution-bindings.test.ts`: authority, approval, events, evidence, and terminal behavior.
- Create `apps/automation-browser-worker/src/production-runtime.ts`: dispatch server, Worker loop, readiness, and shutdown.
- Create `apps/automation-browser-worker/src/production-runtime.test.ts`: startup, disconnect, readiness, and shutdown tests.
- Create `apps/automation-browser-worker/src/main.ts`: thin production bootstrap.
- Modify `apps/automation-browser-worker/src/worker.ts`: reject failed work items before leaving the authenticated loop.
- Modify `apps/automation-browser-worker/src/worker.test.ts`: failed-execution source cleanup tests.
- Modify `apps/automation-browser-worker/src/dispatch-source.ts`: composite readiness input.
- Modify `apps/automation-browser-worker/src/dispatch-source.test.ts`: execution readiness assertions.
- Modify `apps/automation-browser-worker/Dockerfile`: start the thin entrypoint and expose verifiable isolation settings.

---

### Task 1: Add the Versioned Browser Authority Contract

**Files:**
- Modify: `packages/intelligence-contracts/src/automation.ts`
- Modify: `packages/intelligence-contracts/src/automation.test.ts`

**Interfaces:**
- Produces: `AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH`
- Produces: `AutomationBrowserAuthorityCheckInput`, `AutomationBrowserAuthorityCheckRequest`, and `AutomationBrowserAuthorityCheckAccepted`
- Consumed by: Tasks 3, 4, 9, and 10

- [ ] **Step 1: Write strict contract tests**

Add tests that accept every authority kind and reject unknown fields or secret-shaped fields:

```ts
const binding = {
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  lease_owner: `browser-worker-1:${LEASE_ID}`,
  request_hash: `sha256:${'a'.repeat(64)}`,
  kill_switch_generation: 7,
  requested_at: '2099-07-23T10:00:00.000Z',
};

for (const check of [
  { kind: 'lease' },
  { kind: 'generation' },
  { kind: 'cursor', resume_after_sequence: 2 },
  { kind: 'action', step_id: STEP_ID, action_hash: `sha256:${'b'.repeat(64)}` },
  { kind: 'full_access' },
] as const) {
  expect(AutomationBrowserAuthorityCheckInputSchema.parse({ ...binding, check }).check).toEqual(
    check,
  );
}

expect(() =>
  AutomationBrowserAuthorityCheckInputSchema.parse({
    ...binding,
    check: { kind: 'lease' },
    token: 'must-not-be-accepted',
  }),
).toThrow();
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts
```

Expected: FAIL because the authority path and schemas are not exported.

- [ ] **Step 3: Implement the strict schemas**

Add the following contract shape beside the existing heartbeat/consume contracts:

```ts
export const AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH =
  '/internal/automation/browser/authority/check' as const;

const AutomationBrowserAuthorityBindingShape = {
  account_id: UuidSchema,
  project_id: UuidSchema,
  job_id: UuidSchema,
  lease_id: UuidSchema,
  lease_owner: z.string().trim().min(1).max(128),
  request_hash: Sha256HashSchema,
  kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requested_at: DateTimeSchema,
} as const;

export const AutomationBrowserAuthorityCheckInputSchema = z
  .object({
    ...AutomationBrowserAuthorityBindingShape,
    check: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('lease') }).strict(),
      z.object({ kind: z.literal('generation') }).strict(),
      z
        .object({
          kind: z.literal('cursor'),
          resume_after_sequence: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
        })
        .strict(),
      z
        .object({
          kind: z.literal('action'),
          step_id: UuidSchema,
          action_hash: Sha256HashSchema,
        })
        .strict(),
      z.object({ kind: z.literal('full_access') }).strict(),
    ]),
  })
  .strict();
export type AutomationBrowserAuthorityCheckInput = z.infer<
  typeof AutomationBrowserAuthorityCheckInputSchema
>;

export const AutomationBrowserAuthorityCheckRequestSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    proof: AutomationWorkerServiceProofSchema,
    authority: AutomationBrowserAuthorityCheckInputSchema,
  })
  .strict();
export type AutomationBrowserAuthorityCheckRequest = z.infer<
  typeof AutomationBrowserAuthorityCheckRequestSchema
>;

export const AutomationBrowserAuthorityCheckAcceptedSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    authorized: z.literal(true),
    check: z.enum(['lease', 'generation', 'cursor', 'action', 'full_access']),
    job_id: UuidSchema,
    lease_id: UuidSchema,
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    full_access_grant_current: z.boolean(),
    checked_at: DateTimeSchema,
  })
  .strict();
export type AutomationBrowserAuthorityCheckAccepted = z.infer<
  typeof AutomationBrowserAuthorityCheckAcceptedSchema
>;
```

- [ ] **Step 4: Run contracts and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts exec bun test src/automation.test.ts
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
```

Expected: all authority schema tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit the contract**

```powershell
git add packages/intelligence-contracts/src/automation.ts packages/intelligence-contracts/src/automation.test.ts
git commit -m "feat: define browser authority checks"
```

### Task 2: Separate Control Signing From Worker Verification

**Files:**
- Modify: `apps/automation-control/src/config.ts`
- Modify: `apps/automation-control/src/server.test.ts`
- Modify: `apps/automation-control/src/dispatch/worker-auth.ts`
- Create: `apps/automation-control/src/dispatch/worker-auth-signer.test.ts`
- Modify: `apps/automation-control/src/dispatch/browser-dispatcher.ts`
- Modify: `apps/automation-control/src/dispatch/dispatch.test.ts`

**Interfaces:**
- Produces: `WorkerServiceSigner.sign(body, timestamp)`
- Produces config fields: `controlCertificateFingerprint256`, `controlWorkerSharedSecret`, `browserApprovalResumeTokenPepper`
- Consumed by: Tasks 5 and 8

- [ ] **Step 1: Write failing config and signer tests**

Add tests proving dispatch needs its dedicated identity and Resume needs its own pepper:

```ts
expect(() =>
  loadAutomationControlConfig({
    ...enabledControlEnvironment,
    AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
    AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
    AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
    AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: 'AA:BB:CC',
    AUTOMATION_CONTROL_WORKER_SHARED_SECRET: 'control-worker-secret-at-least-32-bytes',
  }),
).toThrow(/TOKEN_PEPPER/i);

const signer = createWorkerServiceSigner({
  serviceId: 'automation-control',
  certificateFingerprint256: 'AA:BB:CC',
  sharedSecret: 'control-worker-secret-at-least-32-bytes',
  nextNonce: () => 101,
});
expect(signer.sign({ job_id: JOB_ID }, NOW)).toMatchObject({
  service_id: 'automation-control',
  nonce: 101,
  timestamp: NOW.toISOString(),
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/server.test.ts src/dispatch/worker-auth-signer.test.ts src/dispatch/dispatch.test.ts
```

Expected: FAIL because the dedicated config fields and signer do not exist.

- [ ] **Step 3: Add dedicated configuration and signer**

Use these exact environment variables and return fields:

```ts
AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: z.string().trim().max(256).default(''),
AUTOMATION_CONTROL_WORKER_SHARED_SECRET: z.string().max(4_096).default(''),
AUTOMATION_APPROVAL_RESUME_TOKEN_PEPPER: z.string().max(4_096).default(''),
```

Require certificate fingerprint and the dedicated secret when Browser dispatch is enabled; require
the pepper when Browser Approval Resume is enabled. Do not reuse `AUTOMATION_CONTROL_SHARED_SECRET`.

Add a standalone signer:

```ts
export type WorkerServiceSigner = Readonly<{
  sign(body: unknown, timestamp: Date): WorkerServiceProof;
}>;

export function createWorkerServiceSigner(input: {
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  nextNonce: () => number;
}): WorkerServiceSigner {
  let lastNonce = 0;
  return Object.freeze({
    sign(body, timestamp) {
      const nonce = input.nextNonce();
      if (!Number.isSafeInteger(nonce) || nonce <= lastNonce || nonce < 1) {
        throw new WorkerAuthenticationError(
          'worker service signing nonce is invalid',
          'invalid_configuration',
        );
      }
      lastNonce = nonce;
      return Object.freeze({
        service_id: input.serviceId,
        timestamp: timestamp.toISOString(),
        nonce,
        signature: signatureFor(
          {
            serviceId: input.serviceId,
            certificateFingerprint256: input.certificateFingerprint256,
            timestamp,
            nonce,
            body,
          },
          input.sharedSecret,
        ),
      });
    },
  });
}
```

Change `createBrowserDispatcher` to consume `signer: WorkerServiceSigner` and call
`input.signer.sign(raw.envelope, dispatchedAt)`. Keep the inbound authenticator only for peer and
receipt verification.

- [ ] **Step 4: Run focused tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/server.test.ts src/dispatch/worker-auth-signer.test.ts src/dispatch/dispatch.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: all focused tests PASS; a local Control signer is never accepted as a remote Worker peer.

- [ ] **Step 5: Commit the security split**

```powershell
git add apps/automation-control/src/config.ts apps/automation-control/src/server.test.ts apps/automation-control/src/dispatch/worker-auth.ts apps/automation-control/src/dispatch/worker-auth-signer.test.ts apps/automation-control/src/dispatch/browser-dispatcher.ts apps/automation-control/src/dispatch/dispatch.test.ts
git commit -m "feat: separate control worker signing"
```

### Task 3: Implement Current Browser Authority Storage

**Files:**
- Create: `apps/automation-control/src/dispatch/browser-authority-store.ts`
- Create: `apps/automation-control/src/dispatch/browser-authority-store.test.ts`

**Interfaces:**
- Consumes: `AutomationBrowserAuthorityCheckInput` from Task 1
- Produces: `BrowserAuthorityStore.check(input, now)`
- Consumed by: Task 4

- [ ] **Step 1: Write failing authority cases**

Drive the store through an injected snapshot reader so every rejection is deterministic:

```ts
const store = createBrowserAuthorityStore(async () => ({
  job: {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    executionDomain: 'browser',
    requestHash: REQUEST_HASH,
    request: REQUEST,
    status: 'running',
    leaseOwner: OWNER,
    leaseExpiresAt: '2099-07-23T10:30:00.000Z',
    deadlineAt: '2099-07-23T11:00:00.000Z',
    killSwitchGeneration: 7,
    cancelRequestedAt: null,
    approvalPolicy: 'full-access',
  },
  step: { stepId: STEP_ID, sequence: 3, actionHash: ACTION_HASH, status: 'running' },
  maxCompletedSequence: 2,
  fullAccessAllowed: true,
}));

expect(await store.check(authorityInput({ kind: 'action' }), NOW)).toMatchObject({
  accepted: true,
  currentGeneration: 7,
  fullAccessGrantCurrent: true,
});
expect(
  await store.check({ ...authorityInput({ kind: 'lease' }), lease_owner: 'stale' }, NOW),
).toEqual({ accepted: false, reason: 'stale_lease' });
```

Also cover expired lease/deadline, cancellation, wrong tenant/project/request hash, stale generation,
changed action hash, changed cursor, terminal Step, and revoked full access.

- [ ] **Step 2: Run the store test and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-authority-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement pure checks plus the PostgreSQL snapshot reader**

Define the exact result and enforce common lease fencing before kind-specific checks:

```ts
export type BrowserAuthorityCheckResult =
  | Readonly<{
      accepted: true;
      checkedAt: string;
      currentGeneration: number;
      fullAccessGrantCurrent: boolean;
    }>
  | Readonly<{
      accepted: false;
      reason: 'stale_lease' | 'dispatch_mismatch';
    }>;

export interface BrowserAuthorityStore {
  check(
    input: AutomationBrowserAuthorityCheckInput,
    now: Date,
  ): Promise<BrowserAuthorityCheckResult>;
}
```

The implementation must reject unless all common fields match a live Browser Job with status
`dispatched` or `running`, no cancellation request, a future deadline/lease, and the exact current
generation. For `action`, require the exact Step ID/hash and `pending` or `running` status. For
`cursor`, require the maximum completed Step sequence to equal `resume_after_sequence`. For
`full_access`, return an accepted current lease check and set `fullAccessGrantCurrent` to true only
when both Job policy is `full-access` and current project policy has `fullAccessAllowed=true`.
Revocation therefore falls back to durable approval instead of failing the whole Job.

Export:

```ts
export function createPostgresBrowserAuthorityStore(db: Database): BrowserAuthorityStore {
  return createBrowserAuthorityStore(async (input) => loadPostgresAuthoritySnapshot(db, input));
}
```

The PostgreSQL reader must select only the requested account/project/job, join the requested Step
when `kind === 'action'`, read `automationPolicies.fullAccessAllowed`, and compute completed cursor
with `max(automationJobSteps.sequence)` filtered by `status='completed'`.

- [ ] **Step 4: Run store tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-authority-store.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: every mismatch returns a stable rejection without exposing database details.

- [ ] **Step 5: Commit the authority store**

```powershell
git add apps/automation-control/src/dispatch/browser-authority-store.ts apps/automation-control/src/dispatch/browser-authority-store.test.ts
git commit -m "feat: verify browser execution authority"
```

### Task 4: Expose the Authenticated Internal Authority Route

**Files:**
- Create: `apps/automation-control/src/dispatch/browser-authority-route.ts`
- Create: `apps/automation-control/src/dispatch/browser-authority-route.test.ts`

**Interfaces:**
- Consumes: Task 1 request/accepted schemas and Task 3 `BrowserAuthorityStore`
- Produces: `createBrowserAuthorityRoute(dependencies): Hono`
- Consumed by: Task 5

- [ ] **Step 1: Write failing route security tests**

Mirror the consume-route harness and assert authenticated success, replay rejection, body bounds,
timeout, stale lease mapping, and secret redaction:

```ts
const response = await route.fetch(attestedAuthorityRequest(signedAuthorityBody(41)));
expect(response.status).toBe(200);
expect(await response.json()).toEqual({
  protocol_version: 'automation.v1',
  authorized: true,
  check: 'action',
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  kill_switch_generation: 7,
  full_access_grant_current: false,
  checked_at: NOW.toISOString(),
});

expect((await route.fetch(attestedAuthorityRequest(signedAuthorityBody(41)))).status).toBe(409);
```

- [ ] **Step 2: Run the route test and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-authority-route.test.ts
```

Expected: FAIL because the route factory does not exist.

- [ ] **Step 3: Implement the route with existing Worker HTTP authentication**

The route must call `authenticateWorkerHttpRequest`, verify the signed body with the shared
authenticator, call the store, and return only the accepted schema:

```ts
app.post(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, async (context) => {
  const checkedAt = now();
  const authenticated = await authenticateWorkerHttpRequest({
    request: context.req.raw,
    expectedPath: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
    tlsAttestationSecret: dependencies.tlsAttestationSecret,
    authenticator: dependencies.authenticator,
    now: checkedAt,
    maxSkewMs,
    maxBodyBytes,
    bodyReadTimeoutMs,
  });
  if (!authenticated.accepted) return mapAuthenticationFailure(authenticated.reason);

  const parsed = parseAuthorityRequest(authenticated.body, authenticated.peer.serviceId);
  if (parsed === null) return unauthorized();
  await dependencies.authenticator.verify({
    peer: authenticated.peer,
    expectedRole: 'browser-worker',
    proof: parsed.proof,
    body: parsed.authority,
  });
  const result = await dependencies.store.check(parsed.authority, checkedAt);
  if (!result.accepted) return authorityConflict(result.reason);
  return context.json(
    AutomationBrowserAuthorityCheckAcceptedSchema.parse({
      protocol_version: 'automation.v1',
      authorized: true,
      check: parsed.authority.check.kind,
      job_id: parsed.authority.job_id,
      lease_id: parsed.authority.lease_id,
      kill_switch_generation: result.currentGeneration,
      full_access_grant_current: result.fullAccessGrantCurrent,
      checked_at: result.checkedAt,
    }),
  );
});
```

Map stale lease to `AUTOMATION_LEASE_EXPIRED`, all other authority rejection to
`AUTOMATION_CONFLICT`, and dependencies to redacted `AUTOMATION_UNAVAILABLE`.

- [ ] **Step 4: Run route tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-authority-route.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: all route tests PASS and no response contains request hashes, secrets, or dependency URLs.

- [ ] **Step 5: Commit the route**

```powershell
git add apps/automation-control/src/dispatch/browser-authority-route.ts apps/automation-control/src/dispatch/browser-authority-route.test.ts
git commit -m "feat: authenticate browser authority checks"
```

### Task 5: Compose One Shared Control Worker Security Runtime

**Files:**
- Create: `apps/automation-control/src/dispatch/worker-security-runtime.ts`
- Create: `apps/automation-control/src/dispatch/browser-worker-routes.ts`
- Create: `apps/automation-control/src/dispatch/browser-worker-routes.test.ts`
- Modify: `apps/automation-control/src/dispatch/heartbeat-runtime.ts`
- Modify: `apps/automation-control/src/dispatch/heartbeat-runtime.test.ts`

**Interfaces:**
- Consumes: Task 2 signer/config, Task 3 store, and Task 4 route
- Produces: `createWorkerSecurityRuntime` and `createBrowserWorkerRoutes`
- Consumed by: Task 8

- [ ] **Step 1: Write failing shared-auth and gate tests**

Prove there is one Redis nonce namespace and that routes mount at the correct gate level:

```ts
const runtime = createWorkerSecurityRuntime({
  config: enabledConfig,
  redis: redisHarness.client,
  nextNonce: () => 101,
});
expect(runtime.signer.sign({ job_id: JOB_ID }, NOW).nonce).toBe(101);

const routes = createBrowserWorkerRoutes({
  config: enabledConfig,
  security: runtime,
  leaseManager,
  heartbeatEventSink,
  authorityStore,
  approvalResumeStore,
});
expect((await routes.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, { method: 'POST' })).status).not.toBe(404);
expect((await routes.request(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, { method: 'POST' })).status).not.toBe(404);
expect((await routes.request(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, { method: 'POST' })).status).not.toBe(404);
```

Add a disabled configuration case where none of the three routes is mounted. Add a dispatch-only
case where heartbeat and authority exist but approval consume remains absent.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-worker-routes.test.ts src/dispatch/heartbeat-runtime.test.ts
```

Expected: FAIL because the shared runtime and route composer are absent.

- [ ] **Step 3: Implement shared security and route composition**

Create one Redis replay store and keep the signer separate:

```ts
export function createWorkerSecurityRuntime(input: {
  config: AutomationControlConfig;
  redis: WorkerRedisCommandClient;
  nextNonce: () => number;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const nonceStore = createRedisWorkerNonceStore(input.redis, {
    ttlMs: Math.min(input.config.workerProofSkewMs * 2, 10 * 60_000),
  });
  return Object.freeze({
    authenticator: createWorkerServiceAuthenticator({
      trustedPeers: input.config.browserWorkerPeers,
      nonceStore,
      now,
      maxSkewMs: input.config.workerProofSkewMs,
    }),
    signer: createWorkerServiceSigner({
      serviceId: input.config.serviceId,
      certificateFingerprint256: input.config.controlCertificateFingerprint256,
      sharedSecret: input.config.controlWorkerSharedSecret,
      nextNonce: input.nextNonce,
    }),
  });
}
```

Change `createBrowserWorkerHeartbeatRuntime` to receive `authenticator` and remove its internal
nonce-store construction. Compose routes using a single `Hono` instance:

```ts
export function createBrowserWorkerRoutes(input: BrowserWorkerRoutesInput): Hono {
  const routes = new Hono();
  if (!input.config.enabled || !input.config.browserHeartbeatEnabled) return routes;
  routes.route('/', createBrowserWorkerHeartbeatRuntime({ ...input, authenticator: input.security.authenticator }));
  if (input.config.browserDispatch.enabled) {
    routes.route('/', createBrowserAuthorityRoute({ ...input, authenticator: input.security.authenticator }));
  }
  if (input.config.browserApprovalResumeEnabled) {
    routes.route('/', createBrowserApprovalResumeRoute({ ...input, authenticator: input.security.authenticator }));
  }
  return routes;
}
```

- [ ] **Step 4: Run Control dispatch tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-worker-routes.test.ts src/dispatch/heartbeat-runtime.test.ts src/dispatch/browser-approval-resume-route.test.ts src/dispatch/browser-authority-route.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: all route factories share replay protection and all tests PASS.

- [ ] **Step 5: Commit shared route security**

```powershell
git add apps/automation-control/src/dispatch/worker-security-runtime.ts apps/automation-control/src/dispatch/browser-worker-routes.ts apps/automation-control/src/dispatch/browser-worker-routes.test.ts apps/automation-control/src/dispatch/heartbeat-runtime.ts apps/automation-control/src/dispatch/heartbeat-runtime.test.ts
git commit -m "feat: share browser worker security runtime"
```

### Task 6: Add Production Private Evidence Storage

**Files:**
- Modify: `packages/studio-adapters/src/config.ts`
- Modify: `packages/studio-adapters/src/config.test.ts`
- Modify: `apps/automation-browser-worker/package.json`
- Modify: `apps/automation-browser-worker/src/config.ts`
- Create: `apps/automation-browser-worker/src/evidence-store.ts`
- Create: `apps/automation-browser-worker/src/evidence-store.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `parseStudioStorageEnvironment`
- Produces: `BrowserWorkerEvidenceConfig` and `createStudioBrowserEvidenceStore`
- Consumed by: Tasks 10 and 11

- [ ] **Step 1: Write failing independent-storage and evidence tests**

Prove S3 config does not require an AI provider and evidence never returns a URL:

```ts
const storage = parseStudioStorageEnvironment({
  STUDIO_OBJECT_STORE_MODE: 's3',
  STUDIO_OBJECT_STORE_BUCKET: 'openopc-private',
  STUDIO_OBJECT_STORE_PREFIX: 'browser',
  STUDIO_S3_ENDPOINT: 'https://oss.example.test',
  STUDIO_S3_REGION: 'cn-shanghai',
  STUDIO_S3_CREDENTIAL_MODE: 'default-chain',
  STUDIO_S3_SSE: 'AES256',
});
expect(storage).toMatchObject({ mode: 's3', bucket: 'openopc-private' });

await evidence.put({
  tenantId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  jobId: JOB_ID,
  leaseId: LEASE_ID,
  stepId: STEP_ID,
  reference: `evidence:${EVIDENCE_ID}`,
  contentType: 'image/png',
  body: new Uint8Array([1, 2, 3]),
});
expect(objectStore.puts[0]?.key).toBe(
  `automation-evidence/${ACCOUNT_ID}/${PROJECT_ID}/${JOB_ID}/${LEASE_ID}/${STEP_ID}/${EVIDENCE_ID}`,
);
expect(JSON.stringify(objectStore.puts)).not.toMatch(/https?:|signature|signed/i);
```

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/studio-adapters exec bun test src/config.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/evidence-store.test.ts
```

Expected: FAIL because storage parsing is coupled to provider activation and the evidence adapter is absent.

- [ ] **Step 3: Extract storage parsing and implement the adapter**

Export a storage-only parser from Studio adapters and call it from the existing adapter parser:

```ts
export function parseStudioStorageEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: { test?: boolean } = {},
): StudioMemoryStorageConfig | StudioS3StorageConfig {
  const parsed = StorageEnvironmentSchema.parse(env);
  return parsed.STUDIO_OBJECT_STORE_MODE === 'memory'
    ? parseMemoryStorage(parsed, options)
    : parseS3Storage(parsed, options);
}
```

In Worker config, require `mode === 's3'` whenever Browser dispatch is enabled. Add
`@kortix/studio-adapters` and `@kortix/studio-runtime` workspace dependencies.

Implement the `EvidenceStore` adapter with strict UUID/reference validation, checksum, immutable
write, and bound metadata:

```ts
export function createStudioBrowserEvidenceStore(store: StudioObjectStore): EvidenceStore {
  return Object.freeze({
    async put(input) {
      const evidenceId = parseEvidenceInput(input);
      const checksum = createHash('sha256').update(input.body).digest('hex');
      await store.putObject({
        key: [
          'automation-evidence',
          input.tenantId,
          input.projectId,
          input.jobId,
          input.leaseId,
          input.stepId,
          evidenceId,
        ].join('/'),
        body: new Blob([input.body]).stream(),
        content_type: input.contentType,
        size_bytes: input.body.byteLength,
        checksum_sha256: checksum,
        metadata: {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          job_id: input.jobId,
          lease_id: input.leaseId,
          step_id: input.stepId,
        },
        if_none_match: '*',
      });
    },
  });
}
```

- [ ] **Step 4: Run storage/Worker tests and typechecks GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/studio-adapters exec bun test src/config.test.ts src/storage/s3-object-store.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/evidence-store.test.ts
pnpm.cmd --filter @kortix/studio-adapters typecheck
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: all checks PASS; memory storage remains test-only and production Browser dispatch requires S3.

- [ ] **Step 5: Commit private evidence storage**

```powershell
git add packages/studio-adapters/src/config.ts packages/studio-adapters/src/config.test.ts apps/automation-browser-worker/package.json apps/automation-browser-worker/src/config.ts apps/automation-browser-worker/src/evidence-store.ts apps/automation-browser-worker/src/evidence-store.test.ts pnpm-lock.yaml
git commit -m "feat: store browser evidence privately"
```

### Task 7: Manage WSS Connection State and Bounded Reconnect

**Files:**
- Modify: `apps/automation-control/src/dispatch/browser-worker-connection.ts`
- Modify: `apps/automation-control/src/dispatch/browser-worker-connection.test.ts`
- Create: `apps/automation-control/src/dispatch/managed-browser-worker-connection.ts`
- Create: `apps/automation-control/src/dispatch/managed-browser-worker-connection.test.ts`

**Interfaces:**
- Produces: `ObservableBrowserWorkerConnection.state()` and `.subscribe(listener)`
- Produces: `ManagedBrowserWorkerConnection.isReady()` and `.close()`
- Consumed by: Task 8

- [ ] **Step 1: Write failing state-machine tests**

Cover `connecting -> ready -> unusable`, unknown result disposal, one reconnect timer, and shutdown:

```ts
const managed = createManagedBrowserWorkerConnection({
  peer,
  connect: () => connections.shift() as ObservableBrowserWorkerConnection,
  schedule: scheduler.schedule,
  cancel: scheduler.cancel,
  initialBackoffMs: 250,
  maxBackoffMs: 5_000,
});

expect(managed.isReady()).toBeFalse();
first.emitState('ready');
expect(managed.isReady()).toBeTrue();
first.rejectNext(new BrowserWorkerConnectionError('unknown', 'unknown_result'));
await expect(managed.send(dispatchInput)).rejects.toMatchObject({ reason: 'unknown_result' });
expect(managed.isReady()).toBeFalse();
scheduler.runNext();
second.emitState('ready');
expect(managed.isReady()).toBeTrue();
```

- [ ] **Step 2: Run connection tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-worker-connection.test.ts src/dispatch/managed-browser-worker-connection.test.ts
```

Expected: FAIL because observable and managed connection APIs do not exist.

- [ ] **Step 3: Implement observable state and manager**

Extend the low-level connection without changing `BrowserWorkerConnection.send` semantics:

```ts
export type BrowserWorkerConnectionState = 'connecting' | 'ready' | 'unusable';

export type ObservableBrowserWorkerConnection = BrowserWorkerConnection &
  Readonly<{
    state(): BrowserWorkerConnectionState;
    subscribe(listener: (state: BrowserWorkerConnectionState) => void): () => void;
    close(reason?: string): void;
  }>;
```

The manager owns exactly one low-level connection and one reconnect timer. It must replace a
connection after `unavailable` or `unknown_result`, must never retry `in_flight`, and must cap
backoff at 5 seconds. Its stable facade is:

```ts
export type ManagedBrowserWorkerConnection = BrowserWorkerConnection &
  Readonly<{
    isReady(): boolean;
    close(reason?: string): void;
  }>;
```

`close()` cancels the timer, closes the current socket, rejects future sends with `unavailable`, and
is idempotent.

- [ ] **Step 4: Run connection tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/dispatch/browser-worker-connection.test.ts src/dispatch/managed-browser-worker-connection.test.ts
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: all state/backoff tests PASS with no second in-flight dispatch.

- [ ] **Step 5: Commit managed WSS lifecycle**

```powershell
git add apps/automation-control/src/dispatch/browser-worker-connection.ts apps/automation-control/src/dispatch/browser-worker-connection.test.ts apps/automation-control/src/dispatch/managed-browser-worker-connection.ts apps/automation-control/src/dispatch/managed-browser-worker-connection.test.ts
git commit -m "feat: manage browser worker connections"
```

### Task 8: Compose the Control Production Runtime

**Files:**
- Create: `apps/automation-control/src/production-runtime.ts`
- Create: `apps/automation-control/src/production-runtime.test.ts`
- Modify: `apps/automation-control/src/server.ts`
- Modify: `apps/automation-control/src/server.test.ts`
- Modify: `apps/automation-control/src/main.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, and 7 plus existing resume coordinator/store/poller
- Produces: `startAutomationControlProductionRuntime`
- Consumed by: the Control `main.ts`

- [ ] **Step 1: Write failing default-disabled, readiness, and shutdown tests**

Use injected factories so tests open no real sockets or databases:

```ts
const disabled = await startAutomationControlProductionRuntime({
  environment: {},
  dependencies: harness.dependencies,
});
expect(harness.created).toEqual(['http-server']);
expect((await disabled.app.request('/ready')).status).toBe(503);
await disabled.close();
await disabled.close();
expect(harness.closed).toEqual(['http-server']);

const enabled = await startAutomationControlProductionRuntime({
  environment: fullyEnabledEnvironment,
  dependencies: harness.dependencies,
});
expect(harness.created).toEqual([
  'database',
  'redis',
  'security',
  'worker-routes',
  'managed-connection',
  'browser-resume',
  'poller',
  'http-server',
]);
expect((await enabled.app.request('/ready')).status).toBe(200);
```

Also assert disconnect changes readiness to 503 and shutdown order is poller, connection, server,
Redis, database even when one close throws. Capture observation events and assert they contain only
stable IDs/state/error codes:

```ts
expect(harness.observations.map((event) => event.event)).toEqual([
  'automation_control_started',
  'automation_browser_runtime_ready',
  'automation_browser_runtime_disconnected',
  'automation_control_shutdown',
]);
expect(JSON.stringify(harness.observations)).not.toContain(enabledConfig.controlWorkerSharedSecret);
expect(JSON.stringify(harness.observations)).not.toContain(enabledConfig.browserApprovalResumeTokenPepper);
```

- [ ] **Step 2: Run production-runtime tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control exec bun test src/production-runtime.test.ts src/server.test.ts
```

Expected: FAIL because the production runtime and Browser readiness probe are absent.

- [ ] **Step 3: Implement the Control composition root**

Expose an injectable runtime with one idempotent close path:

```ts
export type AutomationControlProductionRuntime = Readonly<{
  app: Hono;
  port: number;
  close(): Promise<void>;
}>;

export async function startAutomationControlProductionRuntime(
  input: StartAutomationControlProductionRuntimeInput = {},
): Promise<AutomationControlProductionRuntime> {
  const config = loadAutomationControlConfig(input.environment);
  const resources = await createControlResources(config, input.dependencies);
  const runners = composeAutomationDispatchPollingRunner({
    desktop: resources.desktopRuntime,
    browserApprovalResume: resources.browserResumeRuntime,
  });
  const poller = runners
    ? startAutomationDispatchPolling({
        coordinator: runners,
        intervalMs: config.coordinatorPollMs,
        onError: resources.observePollFailure,
      })
    : null;
  const app = createAutomationControlApp({
    config,
    checkDatabase: resources.checkDatabase,
    checkRedis: resources.checkRedis,
    checkBrowserRuntime: () =>
      Promise.resolve(resources.managedConnection?.isReady() ?? !config.browserApprovalResumeEnabled),
    routes: resources.routes,
    workerRoutes: resources.workerRoutes,
  });
  const server = input.dependencies?.serve?.(app, config.port) ??
    Bun.serve({ hostname: '0.0.0.0', port: config.port, fetch: app.fetch });
  return productionRuntime({ app, server, poller, resources });
}
```

`createControlResources` must build the shared security runtime, heartbeat/authority/consume routes,
PostgreSQL resume store using `browserApprovalResumeTokenPepper`, signer-backed dispatcher, managed
connection, Resume coordinator, and existing desktop runtime. It must pass both runners through
`composeAutomationDispatchPollingRunner`; no second timer is allowed.

Pass a redacting observation sink into the Resume store, managed connection, and production runtime.
Emit `automation_control_started`, `automation_browser_runtime_ready`,
`automation_browser_runtime_disconnected`, and `automation_control_shutdown` only on state
transitions; never serialize raw dependency errors.

Extend server readiness with a redacted `browser_dispatch` dependency only when Browser Resume is
enabled. Make `main.ts` only start the runtime, log a redacted started event, and install SIGINT/SIGTERM handlers:

```ts
const runtime = await startAutomationControlProductionRuntime();
const shutdown = () => void runtime.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

- [ ] **Step 4: Run complete Control tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-control test
pnpm.cmd --filter @kortix/automation-control typecheck
```

Expected: all Control tests PASS; default mode creates no DB, Redis, WSS, Resume store, or poller.

- [ ] **Step 5: Commit the Control composition root**

```powershell
git add apps/automation-control/src/production-runtime.ts apps/automation-control/src/production-runtime.test.ts apps/automation-control/src/server.ts apps/automation-control/src/server.test.ts apps/automation-control/src/main.ts
git commit -m "feat: compose automation control runtime"
```

### Task 9: Generalize the Authenticated Worker Event Channel

**Files:**
- Modify: `apps/automation-browser-worker/src/heartbeat-client.ts`
- Modify: `apps/automation-browser-worker/src/heartbeat-client.test.ts`

**Interfaces:**
- Produces: `BrowserWorkerHeartbeatEmitter.emit(input)`
- Preserves: `send(input)` for periodic heartbeat
- Consumed by: Task 11

- [ ] **Step 1: Write failing serial event tests**

Verify heartbeat and action/audit events share one strictly increasing ordinal per lease:

```ts
await emitter.send({ lease: LEASE, request: REQUEST, lastCompletedStep: 0 });
await emitter.emit({
  lease: LEASE,
  request: REQUEST,
  event: {
    type: 'step_completed',
    payload: { step_id: STEP_ID, evidence_reference: `evidence:${EVIDENCE_ID}` },
    trace_id: null,
  },
});
await emitter.emit({
  lease: LEASE,
  request: REQUEST,
  event: { type: 'job_succeeded', payload: { project_id: PROJECT_ID }, trace_id: null },
});

expect(recorded.map((entry) => entry.heartbeat.ordinal)).toEqual([1, 2, 3]);
expect(recorded.map((entry) => entry.heartbeat.event.type)).toEqual([
  'heartbeat',
  'step_completed',
  'job_succeeded',
]);
```

Also prove a failed event poisons only that lease stream, response event mismatch is rejected, and
payloads with secret-shaped keys are not sent.

- [ ] **Step 2: Run heartbeat tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/heartbeat-client.test.ts
```

Expected: FAIL because `emit` does not exist.

- [ ] **Step 3: Refactor heartbeat around one serial emitter**

Extend the public interface:

```ts
export type BrowserWorkerEventSendInput = Readonly<{
  lease: AutomationLease;
  request: AutomationJobRequest;
  event: AutomationWorkerHeartbeat['event'];
  signal?: AbortSignal;
}>;

export type BrowserWorkerHeartbeatEmitter = Readonly<{
  intervalMs: number;
  emit(input: BrowserWorkerEventSendInput): Promise<AutomationEvent>;
  send(input: BrowserWorkerHeartbeatSendInput): Promise<AutomationEvent>;
  closeLease?(leaseId: string): void;
}>;
```

Move ordinal allocation, signing, transport, response validation, and per-lease serialization into
`emit`. Implement `send` as:

```ts
send(input) {
  return emit({
    lease: input.lease,
    request: input.request,
    signal: input.signal,
    event: {
      type: 'heartbeat',
      payload: { last_completed_step: input.lastCompletedStep },
      trace_id: null,
    },
  });
}
```

Validate the accepted response has the same Job ID, event type, payload, and trace ID as the sent
event. Reuse Control's forbidden-sensitive-field vocabulary before transport.

- [ ] **Step 4: Run Worker tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/heartbeat-client.test.ts src/worker.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: existing periodic heartbeat behavior stays green and generic events are serial and bound.

- [ ] **Step 5: Commit the unified event channel**

```powershell
git add apps/automation-browser-worker/src/heartbeat-client.ts apps/automation-browser-worker/src/heartbeat-client.test.ts
git commit -m "feat: emit authenticated browser events"
```

### Task 10: Add a Shared Signed Control Client and Authority Adapter

**Files:**
- Create: `apps/automation-browser-worker/src/worker-control-client.ts`
- Create: `apps/automation-browser-worker/src/worker-control-client.test.ts`
- Create: `apps/automation-browser-worker/src/authority-client.ts`
- Create: `apps/automation-browser-worker/src/authority-client.test.ts`
- Modify: `apps/automation-browser-worker/src/approval-resume-client.ts`
- Modify: `apps/automation-browser-worker/src/approval-resume-client.test.ts`

**Interfaces:**
- Consumes: Task 1 authority contracts and existing Worker mTLS config
- Produces: `WorkerControlClient.request(path, body, schema)` and `createWorkerProofNonceSource`
- Produces: `BrowserAuthorityClient.check(input)`
- Consumed by: Task 11

- [ ] **Step 1: Write failing shared-client and authority tests**

Prove heartbeat, receipt, approval, and authority callers can share the same monotonic nonce source
and bind responses to their requests:

```ts
const authority = createBrowserAuthorityClient({
  client: workerControlClientHarness.client,
  now: () => NOW,
});
const accepted = await authority.check(authorityInput({ kind: 'generation' }));
expect(accepted).toMatchObject({
  authorized: true,
  check: 'generation',
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  kill_switch_generation: 7,
});
expect(workerControlClientHarness.calls[0]).toMatchObject({
  path: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
  proof: { service_id: WORKER_ID, nonce: 101 },
});
```

Add timeout, oversized/malformed response, wrong Job/Lease/check, replayed local nonce, 409, 503,
and error-redaction cases. Re-run existing approval tests to prove raw tokens remain absent from
errors.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/worker-control-client.test.ts src/authority-client.test.ts src/approval-resume-client.test.ts
```

Expected: FAIL because the common client and authority adapter do not exist.

- [ ] **Step 3: Implement one bounded signed mTLS request primitive**

Use one signer/nonce source for all Worker-to-Control request bodies:

```ts
export type WorkerControlClient = Readonly<{
  request<T>(input: {
    path: string;
    bodyKey: string;
    body: unknown;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
  }): Promise<Readonly<{ status: number; ok: boolean; body: T | AutomationError }>>;
}>;

export function createWorkerProofNonceSource(now: () => Date = () => new Date()): () => number {
  let lastNonce = 0;
  return () => {
    const timestampFloor = now().getTime() * 1_000;
    const next = Math.max(lastNonce + 1, timestampFloor);
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new WorkerControlClientError('configuration');
    }
    lastNonce = next;
    return next;
  };
}

export function createWorkerControlClient(input: WorkerControlClientInput): WorkerControlClient {
  const base = strictHttpsOrigin(input.controlUrl);
  let lastNonce = 0;
  return Object.freeze({
    async request(call) {
      const timestamp = input.now().toISOString();
      const nonce = input.nextNonce();
      if (!Number.isSafeInteger(nonce) || nonce <= lastNonce || nonce < 1) {
        throw new WorkerControlClientError('configuration');
      }
      lastNonce = nonce;
      const proof = signWorkerBody({ ...input, body: call.body, timestamp, nonce });
      const response = await boundedMtlsJsonRequest({
        url: new URL(call.path, base),
        body: { protocol_version: 'automation.v1', proof, [call.bodyKey]: call.body },
        signal: call.signal,
        transport: input.transport,
        timeoutMs: input.requestTimeoutMs,
      });
      return parseWorkerControlResponse(response, call.schema);
    },
  });
}
```

Refactor `createBrowserApprovalResumeClient` to delegate signing, mTLS transport, timeout, and
bounded JSON parsing to this primitive while retaining its exact public error type and response
binding.

The production runtime in Task 12 must create exactly one `createWorkerProofNonceSource()` and pass
it to the dispatch receipt source, heartbeat emitter, and shared Control client. Separate nonce
generators for the same Worker service ID are forbidden because Control replay protection is shared
across all three channels.

Implement the authority adapter:

```ts
export function createBrowserAuthorityClient(input: {
  client: WorkerControlClient;
  now?: () => Date;
}): BrowserAuthorityClient {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async check(authority) {
      const request = AutomationBrowserAuthorityCheckInputSchema.parse({
        ...authority,
        requested_at: now().toISOString(),
      });
      const response = await input.client.request({
        path: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
        bodyKey: 'authority',
        body: request,
        schema: AutomationBrowserAuthorityCheckAcceptedSchema,
      });
      return bindAuthorityResponse(response, request);
    },
  });
}
```

- [ ] **Step 4: Run client tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/worker-control-client.test.ts src/authority-client.test.ts src/approval-resume-client.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: all client tests PASS with one monotonic nonce stream and bounded redacted failures.

- [ ] **Step 5: Commit Worker Control clients**

```powershell
git add apps/automation-browser-worker/src/worker-control-client.ts apps/automation-browser-worker/src/worker-control-client.test.ts apps/automation-browser-worker/src/authority-client.ts apps/automation-browser-worker/src/authority-client.test.ts apps/automation-browser-worker/src/approval-resume-client.ts apps/automation-browser-worker/src/approval-resume-client.test.ts
git commit -m "feat: verify browser authority from workers"
```

### Task 11: Build Production Isolation and Execution Bindings

**Files:**
- Create: `apps/automation-browser-worker/src/runtime-isolation.ts`
- Create: `apps/automation-browser-worker/src/runtime-isolation.test.ts`
- Create: `apps/automation-browser-worker/src/execution-bindings.ts`
- Create: `apps/automation-browser-worker/src/execution-bindings.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 9, and 10 plus existing `createDispatchApprovalConsumer`
- Produces: `createBrowserExecutionBindings` and `executeBrowserDispatchWorkItem`
- Consumed by: Task 12

- [ ] **Step 1: Write failing isolation and execution tests**

Isolation must fail for root, writable application code, missing limits, or an unexpected temp root:

```ts
expect(
  await createRuntimeIsolationAttestor({
    probe: isolationProbe({ uid: 1000, appWritable: false, cpuSeconds: 120, memoryMb: 512 }),
    expectedCpuSeconds: 120,
    expectedMemoryMb: 512,
  }).attest(),
).toBeTrue();
expect(
  await createRuntimeIsolationAttestor({
    probe: isolationProbe({ uid: 0, appWritable: false, cpuSeconds: 120, memoryMb: 512 }),
    expectedCpuSeconds: 120,
    expectedMemoryMb: 512,
  }).attest(),
).toBeFalse();
```

Execution tests must prove an authority rejection happens before Playwright launch/external effects,
Resume consumption is bound to the dispatch, `approval_required` pauses without job success, and a
normal completion emits one terminal success:

```ts
await expect(execute(workItem)).rejects.toThrow(/authority/i);
expect(launchBrowser).not.toHaveBeenCalled();

const paused = await execute(approvalRequiredWorkItem);
expect(paused.terminal).toBe('awaiting_approval');
expect(events.map((event) => event.type)).toContain('approval_required');
expect(events.map((event) => event.type)).not.toContain('job_succeeded');
```

- [ ] **Step 2: Run isolation/execution tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/runtime-isolation.test.ts src/execution-bindings.test.ts
```

Expected: FAIL because neither production binding exists.

- [ ] **Step 3: Implement real isolation probes and binding adapters**

The Linux production probe must verify all of these facts rather than trusting an environment flag:

```ts
export type RuntimeIsolationSnapshot = Readonly<{
  platform: string;
  uid: number | null;
  home: string;
  tmpdir: string;
  appWritable: boolean;
  cpuSeconds: number | null;
  memoryMb: number | null;
}>;

export function isolationSnapshotIsCurrent(
  snapshot: RuntimeIsolationSnapshot,
  expected: { cpuSeconds: number; memoryMb: number },
): boolean {
  return (
    snapshot.platform === 'linux' &&
    snapshot.uid !== null &&
    snapshot.uid !== 0 &&
    snapshot.home === '/tmp/openopc-browser' &&
    snapshot.tmpdir === '/tmp/openopc-browser' &&
    !snapshot.appWritable &&
    snapshot.cpuSeconds !== null &&
    snapshot.cpuSeconds <= expected.cpuSeconds &&
    snapshot.memoryMb !== null &&
    snapshot.memoryMb <= expected.memoryMb
  );
}
```

The production probe reads UID, `/proc/self/limits`, `HOME`, `TMPDIR`, and write access to `/app`.

Create execution bindings from a verified work item:

```ts
export function createBrowserExecutionBindings(input: BrowserExecutionBindingInput) {
  const authorityFor = (check: AutomationBrowserAuthorityCheckInput['check']) =>
    input.authority.check(authorityInputFromWorkItem(input.workItem, check));
  return {
    isSignedLeaseValid: async () => (await authorityFor({ kind: 'lease' })).authorized,
    isLeaseCurrent: async () => (await authorityFor({ kind: 'lease' })).authorized,
    currentKillSwitchGeneration: async () =>
      (await authorityFor({ kind: 'generation' })).kill_switch_generation,
    isActionHashCurrent: async (step: AutomationStep) =>
      (await authorityFor({ kind: 'action', step_id: step.step_id, action_hash: step.action_hash }))
        .authorized,
    isFullAccessGrantCurrent: async () =>
      (await authorityFor({ kind: 'full_access' })).full_access_grant_current,
    isResumeCursorCurrent: async ({ resumeAfterSequence }: { resumeAfterSequence: number }) =>
      (
        await authorityFor({ kind: 'cursor', resume_after_sequence: resumeAfterSequence })
      ).authorized,
    isRuntimeIsolationAttested: () => input.isolation.attest(),
    consumeApproval: createDispatchApprovalConsumer({
      workItem: input.workItem,
      client: input.approvalClient,
    }),
    evidenceStore: input.evidenceStore,
    auditSink: eventSinkFor(input, input.workItem),
    actionEventSink: eventSinkFor(input, input.workItem),
    waitForApproval: undefined,
  };
}
```

`executeBrowserDispatchWorkItem` calls `runBrowserWorker`. If the final returned event is
`approval_required`, it returns `awaiting_approval` without a terminal event. Otherwise it emits one
`job_succeeded`. On an execution error it emits one redacted `job_failed` only while the event
channel remains usable, then rethrows.

Persistent profile requests must be rejected before browser launch until a real one-time profile
broker is configured; temporary profiles remain supported.

- [ ] **Step 4: Run execution tests and complete Worker tests GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/runtime-isolation.test.ts src/execution-bindings.test.ts src/approval-resume.test.ts src/worker.test.ts
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: all checks PASS; no production callback is a constant authority bypass.

- [ ] **Step 5: Commit production execution bindings**

```powershell
git add apps/automation-browser-worker/src/runtime-isolation.ts apps/automation-browser-worker/src/runtime-isolation.test.ts apps/automation-browser-worker/src/execution-bindings.ts apps/automation-browser-worker/src/execution-bindings.test.ts
git commit -m "feat: bind browser worker execution"
```

### Task 12: Compose the Browser Worker Production Runtime

**Files:**
- Create: `apps/automation-browser-worker/src/production-runtime.ts`
- Create: `apps/automation-browser-worker/src/production-runtime.test.ts`
- Create: `apps/automation-browser-worker/src/main.ts`
- Modify: `apps/automation-browser-worker/src/worker.ts`
- Modify: `apps/automation-browser-worker/src/worker.test.ts`
- Modify: `apps/automation-browser-worker/src/dispatch-source.ts`
- Modify: `apps/automation-browser-worker/src/dispatch-source.test.ts`
- Modify: `apps/automation-browser-worker/package.json`
- Modify: `apps/automation-browser-worker/Dockerfile`

**Interfaces:**
- Consumes: Tasks 6, 9, 10, and 11
- Produces: `startBrowserWorkerProductionRuntime`
- Consumed by: Worker `main.ts` and Docker

- [ ] **Step 1: Write failing startup/readiness/shutdown tests**

Cover default fail-closed startup, fully enabled construction, authenticated-session readiness,
disconnect, loop failure, and idempotent shutdown:

```ts
const disabled = await startBrowserWorkerProductionRuntime({
  environment: {},
  dependencies: harness.dependencies,
});
expect((await fetch(`${disabled.origin}/ready`)).status).toBe(503);
expect(harness.created).toEqual(['fail-closed-server']);

const enabled = await startBrowserWorkerProductionRuntime({
  environment: fullyEnabledEnvironment,
  dependencies: harness.dependencies,
});
expect((await fetch(`${enabled.origin}/ready`)).status).toBe(503);
harness.dispatchSource.connectAuthenticatedControl();
expect((await fetch(`${enabled.origin}/ready`)).status).toBe(200);
harness.dispatchSource.disconnectControl();
expect((await fetch(`${enabled.origin}/ready`)).status).toBe(503);
await enabled.close();
await enabled.close();
expect(harness.closed).toEqual(['worker-loop', 'dispatch-source', 'server', 'object-store']);
```

Add a `runBrowserWorkerLoop` test where `execute` rejects and the source receives `reject` exactly
once before the loop fails. Assert Worker transition observations are redacted:

```ts
expect(harness.observations.map((event) => event.event)).toEqual([
  'automation_browser_worker_started',
  'automation_browser_worker_ready',
  'automation_browser_worker_disconnected',
  'automation_browser_worker_shutdown',
]);
expect(JSON.stringify(harness.observations)).not.toMatch(/secret|token|signature|authorization/i);
```

- [ ] **Step 2: Run production-runtime tests and verify RED**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker exec bun test src/production-runtime.test.ts src/dispatch-source.test.ts src/worker.test.ts
```

Expected: FAIL because the production runtime and composite readiness do not exist.

- [ ] **Step 3: Implement the Worker composition root and thin entrypoint**

Make failed execution reject the active authenticated source item:

```ts
export async function runBrowserWorkerLoop<T>(input: {
  source: AuthenticatedRequestSource<T>;
  execute(request: T): Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    const envelope = await input.source.next(input.signal);
    if (input.signal.aborted || envelope === null) return;
    if (!envelope.authenticated) {
      await input.source.reject(envelope.request, 'worker request authentication failed');
      continue;
    }
    try {
      await input.execute(envelope.request);
      await input.source.acknowledge(envelope.request);
    } catch (error) {
      await input.source.reject(envelope.request, 'browser execution failed');
      throw error;
    }
  }
}
```

The production runtime must initialize S3 and isolation before opening the dispatch server, then
start the source and loop:

```ts
export async function startBrowserWorkerProductionRuntime(
  input: StartBrowserWorkerProductionRuntimeInput = {},
): Promise<BrowserWorkerProductionRuntime> {
  const dispatchConfig = loadBrowserWorkerDispatchConfig(input.environment);
  if (!dispatchConfig.enabled) return startDisabledRuntime(input);
  const nextNonce = createWorkerProofNonceSource();
  const resources = await createWorkerProductionResources(dispatchConfig, input, {
    dispatchReceiptNonce: nextNonce,
    heartbeatNonce: nextNonce,
    controlRequestNonce: nextNonce,
  });
  await resources.objectStore.assertReady();
  if (!(await resources.isolation.attest())) throw new Error('Browser runtime isolation is invalid');
  const controller = new AbortController();
  let loopReady = true;
  const loop = runBrowserWorkerLoop({
    source: resources.dispatchSource.source,
    signal: controller.signal,
    execute: (workItem) => resources.execute(workItem).then(() => undefined),
  }).catch((error) => {
    loopReady = false;
    resources.dispatchSource.close('Browser execution loop failed');
    throw error;
  });
  const server = startBrowserWorkerDispatchServer({
    port: browserWorkerConfig.port,
    config: dispatchConfig,
    runtime: resources.dispatchSource,
    isExecutionReady: () => loopReady && resources.dependenciesReady(),
  });
  return workerProductionRuntime({ controller, loop, server, resources });
}
```

Change `/ready` and upgrade acceptance in `startBrowserWorkerDispatchServer` to require both
`runtime.isReady()` and `isExecutionReady()`. Disabled mode starts the existing fail-closed server.
Emit `automation_browser_worker_started`, `automation_browser_worker_ready`,
`automation_browser_worker_disconnected`, and `automation_browser_worker_shutdown` on transitions
through a redacting observation sink; dependency exception text is never an event field.

Create `main.ts`:

```ts
const runtime = await startBrowserWorkerProductionRuntime();
const shutdown = () => void runtime.close();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

Point package `start` and Docker `CMD` at `src/main.ts`. Keep the non-root user, bounded `ulimit`,
`/tmp/openopc-browser`, and read-only `/app` permissions used by the runtime isolation attestor.

- [ ] **Step 4: Run complete Worker tests and typecheck GREEN**

Run:

```powershell
pnpm.cmd --filter @kortix/automation-browser-worker test
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: all Worker tests PASS; direct `bun run src/worker.ts` remains fail-closed.

- [ ] **Step 5: Commit the Worker composition root**

```powershell
git add apps/automation-browser-worker/src/production-runtime.ts apps/automation-browser-worker/src/production-runtime.test.ts apps/automation-browser-worker/src/main.ts apps/automation-browser-worker/src/worker.ts apps/automation-browser-worker/src/worker.test.ts apps/automation-browser-worker/src/dispatch-source.ts apps/automation-browser-worker/src/dispatch-source.test.ts apps/automation-browser-worker/package.json apps/automation-browser-worker/Dockerfile
git commit -m "feat: compose browser worker runtime"
```

### Task 13: Run Release-Strength Local Verification

**Files:**
- Verify only; change source files only to fix newly introduced failures.

**Interfaces:**
- Consumes: all previous tasks
- Produces: fresh focused, container, and full-repository evidence

- [ ] **Step 1: Run focused package tests and typechecks**

Run:

```powershell
pnpm.cmd --filter @kortix/intelligence-contracts test
pnpm.cmd --filter @kortix/db test
pnpm.cmd --filter @kortix/studio-adapters test
pnpm.cmd --filter @kortix/automation-control test
pnpm.cmd --filter @kortix/automation-browser-worker test
pnpm.cmd --filter @kortix/intelligence-contracts typecheck
pnpm.cmd --filter @kortix/db typecheck
pnpm.cmd --filter @kortix/studio-adapters typecheck
pnpm.cmd --filter @kortix/automation-control typecheck
pnpm.cmd --filter @kortix/automation-browser-worker typecheck
```

Expected: every listed command exits 0.

- [ ] **Step 2: Run scoped Biome**

Run Biome on the exact changed source/test/config files reported by:

```powershell
git diff --name-only 082af9489..HEAD | rg '\.(ts|json)$' | ForEach-Object { $_ }
```

Then run:

```powershell
$files = git diff --name-only 082af9489..HEAD | rg '\.(ts|json)$'
pnpm.cmd exec biome check $files
```

Expected: exit 0. Do not add historical database files that were not changed by this plan.

- [ ] **Step 3: Build both production images**

Run:

```powershell
docker build -f apps/automation-control/Dockerfile -t openopc-automation-control:activation .
docker build -f apps/automation-browser-worker/Dockerfile -t openopc-browser-worker:activation .
```

Expected: both images build successfully.

- [ ] **Step 4: Smoke default-disabled and invalid activation states**

Run:

```powershell
$controlId = docker run -d --rm -p 4011:4011 openopc-automation-control:activation
$workerId = docker run -d --rm -p 8091:8091 openopc-browser-worker:activation
try {
  Start-Sleep -Seconds 2
  $controlHealth = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4011/health -SkipHttpErrorCheck
  $controlReady = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4011/ready -SkipHttpErrorCheck
  $workerHealth = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8091/health -SkipHttpErrorCheck
  $workerReady = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8091/ready -SkipHttpErrorCheck
  [pscustomobject]@{
    ControlHealth = $controlHealth.StatusCode
    ControlReady = $controlReady.StatusCode
    WorkerHealth = $workerHealth.StatusCode
    WorkerReady = $workerReady.StatusCode
  }
} finally {
  docker stop $controlId $workerId | Out-Null
}

docker run --rm -e AUTOMATION_CONTROL_ENABLED=true -e AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED=true openopc-automation-control:activation
if ($LASTEXITCODE -eq 0) { throw 'partial Control activation unexpectedly succeeded' }

docker run --rm -e AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED=true openopc-browser-worker:activation
if ($LASTEXITCODE -eq 0) { throw 'partial Worker activation unexpectedly succeeded' }
```

Capture only status codes and stable error names; do not print environment values.

Expected:

```text
Control default: /health 200, /ready 503
Worker default:  /health 503 or waiting status, /ready 503
Partial activation: process exits non-zero before accepting work
```

- [ ] **Step 5: Run the restored full repository regression**

Run:

```powershell
pnpm.cmd --reporter=append-only --workspace-concurrency=1 -r --if-present --no-bail test
```

Expected: no new failures. Report the known Windows `@kortix/sandbox-agent-server` baseline
separately with its fresh counts; do not describe that baseline as a pass.

- [ ] **Step 6: Verify repository boundaries**

Run:

```powershell
git diff --check 082af9489..HEAD
git status --short
git log --oneline 082af9489..HEAD
```

Expected: no whitespace errors; the two protected untracked documents remain uncommitted; commits
are limited to the tasks above.

- [ ] **Step 7: Commit only verification fixes, when required**

If verification exposed a newly introduced defect, stage only its source and focused regression
test, then commit with a precise message such as:

```powershell
git add apps/automation-control/src/production-runtime.ts apps/automation-control/src/production-runtime.test.ts
git commit -m "fix: keep browser runtime readiness fail closed"
```

If no source change was required, do not create an empty verification commit.
