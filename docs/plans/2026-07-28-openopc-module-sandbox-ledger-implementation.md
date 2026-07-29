# OpenOPC Module Sandbox Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable, exactly balanced sandbox module commerce for free access, purchases, subscriptions, metered usage, refunds, disputes, versioned revenue splits, and developer settlement statements without charging or paying real money.

**Architecture:** A new append-only commerce schema separates module sandbox commerce from existing user subscription/quota accounting. Server-accepted usage flows from the Task 8 transactional outbox into an idempotent `module-ledger-worker`; each commercial event creates one immutable double-entry transaction, and corrections create compensating transactions. API, SDK, Web, and CLI expose views and commands but never infer balances from UI state.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle/PostgreSQL 16, SQL transactions/advisory locks, transactional outbox, OpenTelemetry, React, existing SDK/CLI patterns.

## Global Constraints

- This is a sandbox commercial ledger only. No card, wallet, bank, tax, invoice, payout, withdrawal, or withdrawable balance exists.
- User subscription/quota billing remains separate and authoritative for platform usage.
- Amounts use integer `bigint` minor or micro units; floating-point values are forbidden.
- Ledger transactions and entries are append-only and balance exactly per sandbox unit code.
- Corrections, refunds, dispute resolutions, and adjustments use compensating entries; no posted entry is updated or deleted.
- Every transaction binds environment, price, split, policy, release, installation, account, project, execution, usage, and idempotency snapshots where applicable.
- Execution, usage, and ledger idempotency keys are separate namespaces.
- Only server-accepted usage from the durable execution outbox is billable; Runner self-report or mutable UI state is not authority.
- Statement views are explicitly labeled sandbox/non-withdrawable.
- Preserve the current dirty Task 8 execution/outbox changes. Task 4 begins only after a user-authorized checkpoint commit and must extend, not rewrite, that path.
- Tenant-scoped reads return opaque not-found responses outside authority.
- Do not modify protected files, use destructive Git commands, or run the full monorepo suite.
- Proposed commits require renewed user authorization.

---

## File Map

- `packages/module-commerce-contracts/*`: exact prices, usage, transactions, disputes, and statement contracts.
- `packages/db/migrations/20260728120000000_module_sandbox_commerce.sql`: append-only commerce schema.
- `packages/db/src/schema/kortix.ts`: Drizzle schema exports.
- `apps/api/src/module-commerce/*`: pricing, entitlement, usage, refund, dispute, and statement services/routes.
- `apps/module-ledger-worker/*`: durable outbox consumer and double-entry posting worker.
- `packages/sdk/src/core/rest/projects-client/module-commerce.ts`: canonical client.
- `apps/web/src/features/developer-center/commerce/*`: Publisher usage/dispute/statement pages.
- `apps/web/src/features/project-modules/module-commerce-panel.tsx`: project-admin purchase/subscription/usage view.
- `apps/cli/src/commands/modules.ts`: `statement` and sandbox commerce commands.
- `packages/db/scripts/module-sandbox-commerce.integration.test.ts`: real PostgreSQL concurrency/idempotency/balance lane.

### Task 1: Define strict sandbox commerce contracts

**Files:**
- Create: `packages/module-commerce-contracts/package.json`
- Create: `packages/module-commerce-contracts/tsconfig.json`
- Create: `packages/module-commerce-contracts/src/index.ts`
- Create: `packages/module-commerce-contracts/src/pricing.ts`
- Create: `packages/module-commerce-contracts/src/usage.ts`
- Create: `packages/module-commerce-contracts/src/ledger.ts`
- Create: `packages/module-commerce-contracts/src/statements.ts`
- Create: `packages/module-commerce-contracts/src/contracts.test.ts`

**Interfaces:**

```ts
export type SandboxUnitCode = `SBOX_${Uppercase<string>}`;
export type ModulePriceKind = 'free'|'purchase'|'subscription'|'metered';
export interface ModulePriceSnapshotV1 {
  schemaVersion:1; priceVersionId:string; releaseId:string; kind:ModulePriceKind;
  unitCode:SandboxUnitCode; amountMicrounits:bigint; meterId:string|null;
  interval:'month'|'year'|null; splitVersionId:string; policyVersion:string;
}
export interface AcceptedModuleUsageV1 {
  schemaVersion:1; environmentId:string; usageId:string; usageIdempotencyKey:string;
  executionId:string; installationId:string; releaseId:string; accountId:string; projectId:string;
  meterId:string; quantityMicrounits:bigint; acceptedAt:string; evidenceDigest:`sha256:${string}`;
}
export interface LedgerPostingV1 {
  accountCode:string; side:'debit'|'credit'; amountMicrounits:bigint; unitCode:SandboxUnitCode;
}
```

- [ ] **Step 1: Write failing exact-contract tests**

Reject floats, unsafe integers, zero/negative postings, non-sandbox unit codes, unknown/excess keys, invalid digests/UUIDs/RFC3339, duplicate accounts, mixed unit codes, unbalanced debit/credit totals, price/meter mismatch, and strings over stated bounds. Assert canonical JSON encodes bigint as decimal strings and parses them back losslessly.

- [ ] **Step 2: Run RED**

Run: `cd packages/module-commerce-contracts; bun test`

Expected: package-not-found failure.

- [ ] **Step 3: Implement exact parsers and balance validation**

```ts
export function assertBalancedPostings(postings: readonly LedgerPostingV1[]): void {
  const debits = new Map<string,bigint>();
  const credits = new Map<string,bigint>();
  for (const posting of postings) {
    const map = posting.side === 'debit' ? debits : credits;
    map.set(posting.unitCode, (map.get(posting.unitCode) ?? 0n) + posting.amountMicrounits);
  }
  const units = new Set([...debits.keys(), ...credits.keys()]);
  if ([...units].some((unit) => debits.get(unit) !== credits.get(unit))) {
    throw new Error('MODULE_LEDGER_UNBALANCED');
  }
}
```

Use package name `@openopc/module-commerce-contracts` with `test` and `typecheck` scripts. Use branded parsers for UUID, digest, idempotency key, decimal bigint, bounded identifiers, and sandbox unit code. Do not export constructors that bypass parsing.

- [ ] **Step 4: Run GREEN**

Run: `cd packages/module-commerce-contracts; bun test; pnpm.cmd typecheck`

Expected: PASS for all lossless and balance tests.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/module-commerce-contracts pnpm-lock.yaml
git commit -m "feat(commerce): define strict sandbox ledger contracts"
```

### Task 2: Add the append-only commerce database schema

**Files:**
- Create: `packages/db/migrations/20260728120000000_module_sandbox_commerce.sql`
- Modify: `packages/db/src/schema/kortix.ts`
- Create: `packages/db/src/module-sandbox-commerce-schema.test.ts`
- Create: `packages/db/scripts/module-sandbox-commerce.integration.test.ts`

**Interfaces:**
- Tables: `module_commerce_environments`, `module_price_versions`, `module_split_versions`, `module_entitlements`, `module_usage_records`, `module_ledger_accounts`, `module_ledger_transactions`, `module_ledger_entries`, `module_disputes`, `module_statement_runs`, `module_statements`, `module_ledger_outbox_receipts`.
- SQL function: `kortix.post_module_ledger_transaction_v1(jsonb) returns uuid`.

- [ ] **Step 1: Write failing schema/integration tests**

Assert account-prefixed foreign keys, one `sandbox` environment namespace, immutable price/split/usage/transaction/entry/statement rows, unique usage and ledger idempotency scopes, balanced postings enforced in the database, no update/delete to posted rows, compensating references, statement period non-overlap per Publisher/unit, tenant RLS/service-role isolation, two concurrent identical posts returning one transaction, and second migration apply success.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd packages/db; bun test src/module-sandbox-commerce-schema.test.ts scripts/module-sandbox-commerce.integration.test.ts
```

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Implement tables, constraints, triggers, and atomic post function**

Store monetary integers as `bigint` constrained `> 0` for individual postings. The post function receives canonical transaction metadata and postings, locks the idempotency scope, inserts the transaction/entries, verifies equal debit/credit sums grouped by unit code before commit, and returns the prior transaction only when its request digest matches. Grant direct entry writes only to the ledger service role.

- [ ] **Step 4: Run GREEN**

Run the RED command, then:

```powershell
pnpm.cmd migrate:lint
pnpm.cmd --filter @kortix/db typecheck
```

Expected: PASS and migration lint exits `0`.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/db/migrations/20260728120000000_module_sandbox_commerce.sql packages/db/src/schema/kortix.ts packages/db/src/module-sandbox-commerce-schema.test.ts packages/db/scripts/module-sandbox-commerce.integration.test.ts
git commit -m "feat(db): add append only module sandbox ledger"
```

### Task 3: Implement versioned pricing, splits, and entitlements

**Files:**
- Create: `apps/api/src/module-commerce/pricing.ts`
- Create: `apps/api/src/module-commerce/pricing.test.ts`
- Create: `apps/api/src/module-commerce/pricing.drizzle.ts`
- Create: `apps/api/src/module-commerce/entitlements.ts`
- Create: `apps/api/src/module-commerce/entitlements.test.ts`
- Create: `apps/api/src/module-commerce/entitlements.drizzle.ts`

**Interfaces:**

```ts
export interface PublishModulePriceInput {
  accountId:string; publisherId:string; releaseId:string; kind:ModulePriceKind;
  unitCode:SandboxUnitCode; amountMicrounits:bigint; meterId?:string; interval?:'month'|'year';
  split:{ publisherBasisPoints:number; platformBasisPoints:number }; policyVersion:string;
  expectedRevision:number; actorUserId:string;
}
export type ModuleEntitlementKind = 'free'|'purchase'|'subscription';
```

- [ ] **Step 1: Write failing domain tests**

Cover free price zero behavior without ledger movement, purchase idempotency, subscription period boundaries, expiration/cancellation, release-specific immutable price snapshot, split exactly 10,000 basis points, no negative/overflow amount, Publisher finance permission, project-admin acquisition permission, update consent when a paid meter or higher ceiling appears, and opaque cross-account responses.

- [ ] **Step 2: Run RED**

Run: `cd apps/api; bun test src/module-commerce/pricing.test.ts src/module-commerce/entitlements.test.ts`

Expected: FAIL because services are absent.

- [ ] **Step 3: Implement revision-fenced price publication and entitlement state**

Price/split versions are immutable. Channel promotion binds a price snapshot ID. Purchase/subscription commands create an entitlement plus a pending ledger command in one database transaction; free access creates only an entitlement/audit record. Subscription renewal is a new period/transaction, never an in-place balance mutation.

- [ ] **Step 4: Run GREEN**

Run the RED command.

Expected: PASS for pricing, split, entitlement, permission, and tenant tests.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/module-commerce/pricing* apps/api/src/module-commerce/entitlements*
git commit -m "feat(commerce): add versioned prices and entitlements"
```

### Task 4: Bind authoritative accepted usage to the Task 8 outbox

**Files:**
- Modify after checkpoint: `apps/api/src/module-runtime/executions.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/executions.test.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/executions.drizzle.ts`
- Modify after checkpoint: `apps/api/src/module-runtime/executions.drizzle.test.ts`
- Create: `apps/api/src/module-commerce/usage-acceptance.ts`
- Create: `apps/api/src/module-commerce/usage-acceptance.test.ts`
- Create: `apps/api/src/module-commerce/usage-acceptance.drizzle.ts`
- Extend: `packages/db/scripts/module-runner-dispatch.integration.test.ts`

**Interfaces:**

```ts
export interface FinalizeAcceptedUsageInput {
  executionId:string; leaseId:string; generation:number; meterId:string;
  quantityMicrounits:bigint; usageIdempotencyKey:string; evidenceDigest:`sha256:${string}`;
}
export interface AcceptedUsageOutboxPayloadV1 extends AcceptedModuleUsageV1 {
  kind:'module.usage.accepted'; ledgerIdempotencySeed:`sha256:${string}`;
}
```

- [ ] **Step 1: Preserve and verify the Task 8 checkpoint**

Run its existing focused API, database, Rust, and two-Runner gates. Confirm the checkpoint is committed with user authorization before modifying overlapping files. If it is still dirty, stop this task without changing those files.

- [ ] **Step 2: Write failing authoritative-usage tests**

Reject usage from stale lease/generation, non-terminal or failed execution, undeclared meter, quantity over descriptor/cost ceiling, mismatched evidence, Runner-only price, repeated usage key with different payload, and cross-account execution. Assert finalize plus accepted usage plus outbox are one transaction; duplicate terminal finalize returns the same accepted usage and outbox row.

- [ ] **Step 3: Run RED**

Run:

```powershell
cd apps/api; bun test src/module-commerce/usage-acceptance.test.ts src/module-runtime/executions.drizzle.test.ts
cd ../../packages/db; bun test scripts/module-runner-dispatch.integration.test.ts
```

Expected: FAIL because accepted-usage binding is absent.

- [ ] **Step 4: Implement server validation and shared terminal transaction**

The Runner supplies bounded counters, never a price or posting. The API resolves installation/release/meter/price/split/policy snapshots, clamps against the signed runtime/consent ceiling, assigns `usageId`, and writes `module_usage_records` plus one `module.usage.accepted` outbox payload in the same terminalization transaction. Maintain separate keys: execution finalization key, usage key, and derived ledger seed.

- [ ] **Step 5: Run GREEN**

Run the RED commands three consecutive times for the real PostgreSQL/two-Runner integration. Preserve and report any failure; do not hide it with retries.

Expected: every run passes and produces exactly one usage/outbox row.

- [ ] **Step 6: Commit boundary**

```powershell
git add apps/api/src/module-runtime apps/api/src/module-commerce/usage-acceptance* packages/db/scripts/module-runner-dispatch.integration.test.ts
git commit -m "feat(commerce): bind accepted usage to execution finalization"
```

### Task 5: Build the idempotent module-ledger-worker

**Files:**
- Create: `apps/module-ledger-worker/package.json`
- Create: `apps/module-ledger-worker/tsconfig.json`
- Create: `apps/module-ledger-worker/Dockerfile`
- Create: `apps/module-ledger-worker/src/config.ts`
- Create: `apps/module-ledger-worker/src/repository.ts`
- Create: `apps/module-ledger-worker/src/repository.drizzle.ts`
- Create: `apps/module-ledger-worker/src/postings.ts`
- Create: `apps/module-ledger-worker/src/postings.test.ts`
- Create: `apps/module-ledger-worker/src/worker.ts`
- Create: `apps/module-ledger-worker/src/worker.test.ts`
- Create: `apps/module-ledger-worker/src/main.ts`

**Interfaces:**

```ts
export interface ModuleLedgerWorkerRepository {
  claim(limit:number, owner:string, leaseUntil:Date):Promise<readonly AcceptedUsageOutboxPayloadV1[]>;
  postUsage(input:{ usage:AcceptedUsageOutboxPayloadV1; postings:LedgerPostingV1[]; requestDigest:`sha256:${string}` }):Promise<string>;
  complete(outboxId:string, transactionId:string):Promise<void>;
  fail(outboxId:string, code:string, availableAt:Date):Promise<void>;
}
```

- [ ] **Step 1: Write failing posting and worker tests**

Cover purchase/subscription/meter postings, Publisher/platform splits, largest-remainder allocation with deterministic tie-break, zero platform share, duplicate delivery, crash after post before receipt, stale lease, out-of-order usage, malformed payload dead-letter, bounded backoff, statement cutoff, and OpenTelemetry correlation. Assert logs never include raw payloads, account emails, tokens, or signed URLs.

- [ ] **Step 2: Run RED**

Run: `pnpm.cmd --filter @openopc/module-ledger-worker test`

Expected: package does not exist.

- [ ] **Step 3: Implement fixed-capacity claims and atomic postings**

Use package name `@openopc/module-ledger-worker` with `"test": "bun test"`, `"typecheck": "tsc --noEmit"`, and `"start": "bun run src/main.ts"`. For metered usage, debit the project sandbox expense account and credit Publisher/platform sandbox revenue accounts according to the accepted snapshot. Claim with `FOR UPDATE SKIP LOCKED`; post through the database function; write consumer receipt after the idempotent transaction returns. A crash between post and receipt replays to the same transaction by ledger idempotency key.

- [ ] **Step 4: Run GREEN**

Run: `pnpm.cmd --filter @openopc/module-ledger-worker test; pnpm.cmd --filter @openopc/module-ledger-worker typecheck`

Expected: PASS with no duplicate transaction under crash replay.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/module-ledger-worker pnpm-lock.yaml
git commit -m "feat(commerce): add idempotent module ledger worker"
```

### Task 6: Implement refunds, disputes, versioned splits, and statements

**Files:**
- Create: `apps/api/src/module-commerce/adjustments.ts`
- Create: `apps/api/src/module-commerce/adjustments.test.ts`
- Create: `apps/api/src/module-commerce/disputes.ts`
- Create: `apps/api/src/module-commerce/disputes.test.ts`
- Create: `apps/module-ledger-worker/src/statements.ts`
- Create: `apps/module-ledger-worker/src/statements.test.ts`
- Create: `apps/module-ledger-worker/src/statements.drizzle.ts`

**Interfaces:**

```ts
export type ModuleDisputeState = 'open'|'under_review'|'accepted'|'rejected'|'resolved';
export interface CompensatingCommand {
  originalTransactionId:string; reasonCode:'refund'|'dispute_accept'|'operator_correction';
  amountMicrounits:bigint; expectedRevision:number; idempotencyKey:string;
}
export interface ModuleStatementV1 {
  publisherId:string; periodStart:string; periodEnd:string; unitCode:SandboxUnitCode;
  grossMicrounits:bigint; refundsMicrounits:bigint; publisherMicrounits:bigint;
  platformMicrounits:bigint; transactionCount:number; statementDigest:`sha256:${string}`;
  label:'SANDBOX - NOT WITHDRAWABLE';
}
```

- [ ] **Step 1: Write failing adjustment/dispute/statement tests**

Assert partial/full refund cannot exceed original net, compensating postings reverse original split snapshot, dispute transitions are revision-fenced and reasoned, operator corrections require step-up/audit, new split versions do not rewrite prior transactions, statement cutoff is repeatable, late compensation appears in the next statement with original reference, and statement totals reconcile to ledger entries.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/module-commerce/adjustments.test.ts src/module-commerce/disputes.test.ts
cd ../module-ledger-worker; bun test src/statements.test.ts
```

Expected: FAIL because services are absent.

- [ ] **Step 3: Implement compensating-only adjustments and deterministic statements**

Never update original entries. Store dispute state events append-only and a current projection with optimistic revision. Statement generation uses a repeatable-read cutoff transaction ID/time, groups exact bigint values, stores canonical JSON digest, and marks completed statements immutable.

- [ ] **Step 4: Run GREEN**

Run the RED commands.

Expected: PASS with exact reconciliation for all sandbox unit codes.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/module-commerce/adjustments* apps/api/src/module-commerce/disputes* apps/module-ledger-worker/src/statements*
git commit -m "feat(commerce): add disputes refunds and statements"
```

### Task 7: Expose commerce through API, SDK, Developer Center, project UI, and CLI

**Files:**
- Create: `apps/api/src/module-commerce/app.ts`
- Create: `apps/api/src/module-commerce/app.test.ts`
- Modify: `apps/api/src/index.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-commerce.ts`
- Create: `packages/sdk/src/core/rest/projects-client/module-commerce.test.ts`
- Modify: `packages/sdk/src/core/rest/projects-client/index.ts`
- Create: `apps/web/src/features/developer-center/commerce/usage-page.tsx`
- Create: `apps/web/src/features/developer-center/commerce/disputes-page.tsx`
- Create: `apps/web/src/features/developer-center/commerce/statements-page.tsx`
- Create: `apps/web/src/features/developer-center/commerce/commerce-pages.test.tsx`
- Create: `apps/web/src/features/project-modules/module-commerce-panel.tsx`
- Modify: `apps/cli/src/commands/modules.ts`
- Modify: `apps/cli/src/__tests__/modules.test.ts`

**Interfaces:**
- Routes under `/v1/module-commerce` and `/v1/projects/:projectId/module-commerce` use explicit Publisher finance or project-admin permissions.
- CLI: `openopc module statement list|get`, `price publish`, `dispute open|get` with `--json` stable output.

- [ ] **Step 1: Write failing transport and UI tests**

Test role separation, tenant opacity, pagination/cursors, bigint decimal serialization, idempotency headers, step-up for adjustment, statement digest, and every visible sandbox label. Assert UI never uses currency symbols alone, never says withdrawable/available payout, and never mixes platform subscription quota with module commerce.

- [ ] **Step 2: Run RED**

Run:

```powershell
cd apps/api; bun test src/module-commerce/app.test.ts
cd ../../packages/sdk; bun test src/core/rest/projects-client/module-commerce.test.ts
cd ../../apps/web; bun test src/features/developer-center/commerce/commerce-pages.test.tsx
cd ../cli; bun test src/__tests__/modules.test.ts
```

Expected: FAIL because transport/UI/CLI surfaces are absent.

- [ ] **Step 3: Implement canonical clients and visible sandbox labeling**

SDK owns transport types and decimal-string conversion. Web and CLI call SDK functions only. Developer Center exposes usage, disputes, and statements based on Publisher roles; project UI exposes entitlement and usage to project admins; every amount includes `SANDBOX - NOT WITHDRAWABLE` context.

- [ ] **Step 4: Run GREEN**

Run the RED commands plus API/SDK/Web/CLI typechecks.

Expected: PASS for role, transport, UI, and machine-output tests.

- [ ] **Step 5: Commit boundary**

```powershell
git add apps/api/src/module-commerce/app* apps/api/src/index.ts packages/sdk/src/core/rest/projects-client apps/web/src/features/developer-center/commerce apps/web/src/features/project-modules/module-commerce-panel.tsx apps/cli/src/commands/modules.ts apps/cli/src/__tests__/modules.test.ts
git commit -m "feat(commerce): expose sandbox module commerce workflows"
```

### Task 8: Close G9 and B6 with real PostgreSQL/API/worker scenarios

**Files:**
- Extend: `packages/db/scripts/module-sandbox-commerce.integration.test.ts`
- Create: `tests/public-beta/module-commerce/run.ts`
- Create: `tests/public-beta/module-commerce/run.test.ts`

**Interfaces:**
- Scenario IDs: `free`, `purchase`, `subscription`, `metered`, `duplicate-delivery`, `refund`, `dispute`, `split-version`, `statement`, `tenant-denial`, `worker-crash-replay`.

- [ ] **Step 1: Write failing acceptance-runner contract tests**

Require real PostgreSQL, API, and worker identities; exact commit/environment; raw SQL balance query; execution→usage→outbox→ledger correlation; artifact digests; and no fake adapter. Reject missing scenario, localhost staging target, self-generated assertion-only evidence, or a balance check performed only in memory.

- [ ] **Step 2: Run RED**

Run: `bun test tests/public-beta/module-commerce/run.test.ts`

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement all scenarios and exact reconciliation**

Create real releases/installations/executions through API, let the real worker post, and independently query PostgreSQL totals grouped by transaction/unit. Inject a worker crash after database post and before receipt, restart it, and prove one transaction. Preserve raw output and the first failure.

- [ ] **Step 4: Run focused integration three times**

Run:

```powershell
cd packages/db; bun test scripts/module-sandbox-commerce.integration.test.ts
bun test scripts/module-sandbox-commerce.integration.test.ts
bun test scripts/module-sandbox-commerce.integration.test.ts
cd ../..; bun test tests/public-beta/module-commerce/run.test.ts
git diff --check
```

Expected: every database run passes with zero container residue. Real canonical G9/B6 staging evidence is still required.

- [ ] **Step 5: Commit boundary**

```powershell
git add packages/db/scripts/module-sandbox-commerce.integration.test.ts tests/public-beta/module-commerce
git commit -m "test(beta): prove balanced sandbox module commerce"
```

## Ledger Completion Gate

- All postings balance per sandbox unit code in the database, not only in TypeScript.
- Duplicate delivery and crash replay produce one usage and one ledger transaction.
- Refunds/disputes/corrections are compensating and preserve original entries.
- Statements reconcile exactly and are visibly non-withdrawable.
- G9 and B6 pass against real staging PostgreSQL/API/worker for the candidate commit.
