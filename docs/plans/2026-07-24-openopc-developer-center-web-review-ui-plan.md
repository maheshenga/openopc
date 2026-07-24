# OpenOPC Developer Center Web Review UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. `subagent-driven-development` is not authorized unless the user explicitly requests subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Web publisher and platform-admin interfaces for the existing governed developer-module review lifecycle without changing its backend rules or Kortix internal contracts.

**Architecture:** Add an isolated `apps/web/src/features/developer-center` feature with pure lifecycle helpers, privilege-neutral display components, publisher hooks backed by the public `@kortix/sdk`, and separate Admin hooks backed by the existing internal `backendApi`. Thin Next.js routes compose list-plus-detail pages; existing User Menu and Admin Sidebar receive minimal additive navigation entries.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, TanStack Query 5, next-intl, Bun test, React server static rendering, Playwright, existing Kortix SDK and Web UI primitives.

## Global Constraints

- OpenOPC is visible branding only; do not rename `@kortix/*` packages, API routes, database objects, or protocols.
- Keep `@kortix/registry` canonical; do not create another catalog or marketplace.
- Do not add database migrations or change the developer-module lifecycle API in this slice.
- Publisher operations use public `@kortix/sdk`; Admin review operations remain Web-internal and must not be exported from the public SDK.
- Publisher queries include `accountId`; Admin queries never reuse publisher cache keys.
- Publisher list loads the latest 100 releases and is labeled **Recent releases**; search and status filtering cover loaded rows only.
- JSON upload and paste input are limited to 1,048,576 UTF-8 bytes before parsing.
- Never persist manifest input, review reasons, or evidence in a URL, LocalStorage, analytics, or general logs.
- Never optimistically display a review transition; every mutation carries server-returned `status` and `review_revision`.
- HTTP 409 discards the stale decision payload, refetches detail/history, and requires explicit resubmission; never replay automatically.
- Do not modify the existing Kortix Review Center.
- Do not restore video, voice, 3D, digital-human, or batch-remix product pages.
- Android and iOS remain out of scope.
- Preserve the two protected untracked files named in the workspace checkpoint; never stage them.

## File Structure

```text
apps/web/src/features/developer-center/
  model.ts                         # pure lifecycle, filtering, parsing, and safe-error helpers
  model.test.ts
  labels.ts                        # typed next-intl label adapter
  shared/
    module-status-badge.tsx
    module-manifest-view.tsx
    module-requirements.tsx
    review-timeline.tsx
    shared-components.test.tsx
  publisher/
    query.ts                       # account-scoped React Query hooks over @kortix/sdk
    query.test.ts
    release-list-page.tsx
    release-detail-page.tsx
    publisher-pages.test.tsx
    submit-controller.ts
    submit-controller.test.ts
    submit-page.tsx
    submit-page.test.tsx
  admin/
    client.ts                      # private Admin HTTP contract over backendApi
    client.test.ts
    query.ts                       # Admin-only React Query hooks
    evidence.ts                    # evidence completeness and decision payloads
    evidence.test.ts
    review-queue-page.tsx
    review-detail-page.tsx
    admin-pages.test.tsx

apps/web/src/app/(app)/developer/modules/page.tsx
apps/web/src/app/(app)/developer/modules/submit/page.tsx
apps/web/src/app/(app)/developer/modules/[releaseId]/page.tsx
apps/web/src/app/admin/developer-reviews/page.tsx
apps/web/src/app/admin/developer-reviews/[releaseId]/page.tsx
apps/web/src/app/(system)/debug/developer-center/page.tsx
apps/web/scripts/e2e/developer-center-review-smoke.ts
```

Existing files modified only where necessary:

```text
apps/web/src/features/layout/user-menu.tsx
apps/web/src/app/admin/_components/admin-sidebar.tsx
apps/web/translations/{en,zh,de,es,fr,it,ja,pt}.json
apps/web/package.json
docs/operations/studio-acceleration-progress.md
```

---

### Task 1: Pure Developer Center lifecycle model

**Files:**
- Create: `apps/web/src/features/developer-center/model.ts`
- Create: `apps/web/src/features/developer-center/model.test.ts`

**Interfaces:**
- Consumes: `DeveloperModuleRelease`, `DeveloperModuleReleaseStatus`, `DeveloperModuleReviewEvidence`, and `DeveloperModuleReviewRequirement` from `@kortix/sdk`.
- Produces: `publisherActionFor`, `filterRecentReleases`, `parseDeveloperModuleInput`, `developerCenterErrorCode`, `requirementComplexity`, and `DEVELOPER_MODULE_INPUT_MAX_BYTES`.

- [ ] **Step 1: Write the failing lifecycle-model tests**

```typescript
import { describe, expect, test } from 'bun:test';
import {
  DEVELOPER_MODULE_INPUT_MAX_BYTES,
  developerCenterErrorCode,
  filterRecentReleases,
  parseDeveloperModuleInput,
  publisherActionFor,
  requirementComplexity,
} from './model';

describe('Developer Center model', () => {
  test('exposes only legal publisher actions', () => {
    expect(publisherActionFor('validated')).toBe('request_review');
    expect(publisherActionFor('changes_requested')).toBe('resubmit');
    expect(publisherActionFor('review_pending')).toBeNull();
    expect(publisherActionFor('approved')).toBeNull();
    expect(publisherActionFor('revoked')).toBeNull();
  });

  test('rejects malformed and over-limit JSON before an API call', () => {
    expect(parseDeveloperModuleInput('{')).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(parseDeveloperModuleInput('x'.repeat(DEVELOPER_MODULE_INPUT_MAX_BYTES + 1))).toEqual({
      ok: false,
      code: 'INPUT_TOO_LARGE',
    });
    expect(parseDeveloperModuleInput('{"type":"registry:module"}')).toEqual({
      ok: true,
      item: { type: 'registry:module' },
    });
  });

  test('filters only loaded recent rows without claiming a total', () => {
    const rows = [
      { module_id: 'acme.recruiting', item_name: 'Recruiting', publisher_id: 'acme', module_version: '1.0.0', status: 'review_pending' },
      { module_id: 'city.listings', item_name: 'Listings', publisher_id: 'city', module_version: '2.0.0', status: 'approved' },
    ] as never[];
    expect(filterRecentReleases(rows, 'recruit', 'review_pending')).toHaveLength(1);
    expect(filterRecentReleases(rows, '', 'all')).toHaveLength(2);
  });

  test('maps unknown errors to a stable non-secret code', () => {
    expect(developerCenterErrorCode({ message: 'Bearer private-token' })).toBe('DEVELOPER_REQUEST_FAILED');
    expect(developerCenterErrorCode({ status: 409, body: { error: 'DEVELOPER_REVIEW_CONFLICT' } })).toBe('DEVELOPER_REVIEW_CONFLICT');
  });

  test('derives complexity only from declared requirements', () => {
    expect(requirementComplexity(['manifest_review', 'human_review'])).toBe('standard');
    expect(requirementComplexity(['desktop_security_review', 'human_review'])).toBe('elevated');
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run from the repository root:

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/model.test.ts
```

Expected: FAIL because `./model` does not exist.

- [ ] **Step 3: Implement the pure model**

```typescript
import type {
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewRequirement,
} from '@kortix/sdk';

export const DEVELOPER_MODULE_INPUT_MAX_BYTES = 1_048_576;
export type PublisherReviewAction = 'request_review' | 'resubmit';
export type ReleaseStatusFilter = DeveloperModuleReleaseStatus | 'all';

export function publisherActionFor(status: DeveloperModuleReleaseStatus): PublisherReviewAction | null {
  if (status === 'validated') return 'request_review';
  if (status === 'changes_requested') return 'resubmit';
  return null;
}

export function parseDeveloperModuleInput(text: string):
  | { ok: true; item: Record<string, unknown> }
  | { ok: false; code: 'EMPTY_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_ROOT' } {
  if (!text.trim()) return { ok: false, code: 'EMPTY_INPUT' };
  if (new TextEncoder().encode(text).byteLength > DEVELOPER_MODULE_INPUT_MAX_BYTES) {
    return { ok: false, code: 'INPUT_TOO_LARGE' };
  }
  try {
    const item: unknown = JSON.parse(text);
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, code: 'INVALID_ROOT' };
    }
    return { ok: true, item: item as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'INVALID_JSON' };
  }
}

export function filterRecentReleases(
  releases: readonly DeveloperModuleRelease[],
  query: string,
  status: ReleaseStatusFilter,
): DeveloperModuleRelease[] {
  const needle = query.trim().toLowerCase();
  return releases.filter((release) => {
    if (status !== 'all' && release.status !== status) return false;
    if (!needle) return true;
    return [release.item_name, release.module_id, release.publisher_id, release.module_version]
      .some((value) => value.toLowerCase().includes(needle));
  });
}

export function requirementComplexity(
  requirements: readonly DeveloperModuleReviewRequirement[],
): 'standard' | 'elevated' {
  return requirements.includes('desktop_security_review') || requirements.includes('permission_review')
    ? 'elevated'
    : 'standard';
}

export function developerCenterErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'DEVELOPER_REQUEST_FAILED';
  const record = error as { code?: unknown; body?: unknown };
  if (typeof record.code === 'string' && record.code.startsWith('DEVELOPER_')) return record.code;
  if (record.body && typeof record.body === 'object') {
    const code = (record.body as { error?: unknown }).error;
    if (typeof code === 'string' && code.startsWith('DEVELOPER_')) return code;
  }
  return 'DEVELOPER_REQUEST_FAILED';
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run the command from Step 2.

Expected: all model tests pass.

- [ ] **Step 5: Commit the model**

```powershell
git add -- apps/web/src/features/developer-center/model.ts apps/web/src/features/developer-center/model.test.ts
git commit -m "feat(web): add developer center lifecycle model"
```

---

### Task 2: Privilege-neutral shared views

**Files:**
- Create: `apps/web/src/features/developer-center/shared/module-status-badge.tsx`
- Create: `apps/web/src/features/developer-center/shared/module-manifest-view.tsx`
- Create: `apps/web/src/features/developer-center/shared/module-requirements.tsx`
- Create: `apps/web/src/features/developer-center/shared/review-timeline.tsx`
- Create: `apps/web/src/features/developer-center/shared/shared-components.test.tsx`

**Interfaces:**
- Consumes: SDK release, status, requirement, and review-event types.
- Produces: `DeveloperModuleStatusBadge`, `DeveloperModuleManifestView`, `DeveloperModuleRequirements`, and `DeveloperModuleReviewTimeline`; none accepts a privileged callback.

- [ ] **Step 1: Write failing static-render tests**

```tsx
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeveloperModuleStatusBadge } from './module-status-badge';
import { DeveloperModuleManifestView } from './module-manifest-view';
import { DeveloperModuleRequirements } from './module-requirements';
import { DeveloperModuleReviewTimeline } from './review-timeline';

describe('Developer Center shared views', () => {
  test('renders stable status and requirement labels', () => {
    const html = renderToStaticMarkup(<><DeveloperModuleStatusBadge status="review_pending" /><DeveloperModuleRequirements requirements={['manifest_review', 'human_review']} /></>);
    expect(html).toContain('Review pending');
    expect(html).toContain('Manifest review');
    expect(html).toContain('Human review');
  });

  test('renders structured permissions and escaped raw JSON', () => {
    const html = renderToStaticMarkup(<DeveloperModuleManifestView manifest={{ id: 'acme.module', permissions: { network: ['https://api.example.test'] }, unsafe: '<script>' }} />);
    expect(html).toContain('acme.module');
    expect(html).toContain('https://api.example.test');
    expect(html).not.toContain('<script>');
  });

  test('renders immutable events without privileged actions', () => {
    const html = renderToStaticMarkup(<DeveloperModuleReviewTimeline events={[{ review_event_id: '1', action: 'submit', from_status: 'validated', to_status: 'review_pending', actor_kind: 'publisher', actor_user_id: 'user', reason: null, evidence: [], created_at: '2026-07-24T00:00:00.000Z', release_id: 'release', account_id: 'account', sequence: 1 } as never]} />);
    expect(html).toContain('Submitted for review');
    expect(html).toContain('Publisher');
    expect(html).not.toContain('Approve');
  });
});
```

- [ ] **Step 2: Run the focused shared-view test and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/shared/shared-components.test.tsx
```

Expected: FAIL with missing shared component modules.

- [ ] **Step 3: Implement focused display components**

Use existing `Badge`, `Card`, `Separator`, and date-formatting primitives. The manifest view must render identity and permissions as normal text, then place canonical pretty JSON inside a closed `<details>` element:

```tsx
export function DeveloperModuleManifestView({ manifest }: { manifest: Record<string, unknown> }) {
  const id = typeof manifest.id === 'string' ? manifest.id : 'Unknown module';
  const permissions = manifest.permissions && typeof manifest.permissions === 'object'
    ? (manifest.permissions as Record<string, unknown>)
    : {};
  return (
    <section aria-label="Module manifest" className="space-y-4">
      <div><p className="text-sm font-medium">{id}</p></div>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.entries(permissions).map(([scope, values]) => (
          <div key={scope} className="rounded-xl border p-3">
            <p className="text-xs font-medium uppercase text-muted-foreground">{scope}</p>
            <p className="mt-1 break-words text-sm">{Array.isArray(values) ? values.join(', ') : 'None'}</p>
          </div>
        ))}
      </div>
      <details className="rounded-xl border p-3">
        <summary className="cursor-pointer text-sm font-medium">Raw manifest</summary>
        <pre className="mt-3 overflow-auto text-xs">{JSON.stringify(manifest, null, 2)}</pre>
      </details>
    </section>
  );
}
```

Status and event labels must be exhaustive `Record<DeveloperModuleReleaseStatus, string>` and `Record<DeveloperModuleReviewAction, string>` maps so a new backend state fails TypeScript until the UI is updated.

- [ ] **Step 4: Run shared tests and TypeScript**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/shared/shared-components.test.tsx
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the shared views**

```powershell
git add -- apps/web/src/features/developer-center/shared
git commit -m "feat(web): add developer center shared views"
```

---

### Task 3: Publisher queries, recent list, and release detail

**Files:**
- Create: `apps/web/src/features/developer-center/publisher/query.ts`
- Create: `apps/web/src/features/developer-center/publisher/query.test.ts`
- Create: `apps/web/src/features/developer-center/publisher/release-list-page.tsx`
- Create: `apps/web/src/features/developer-center/publisher/release-detail-page.tsx`
- Create: `apps/web/src/features/developer-center/publisher/publisher-pages.test.tsx`
- Create: `apps/web/src/app/(app)/developer/modules/page.tsx`
- Create: `apps/web/src/app/(app)/developer/modules/[releaseId]/page.tsx`

**Interfaces:**
- Consumes: `useCurrentAccountStore`, `usePermission`, public developer-module SDK methods, Task 1 filters, and Task 2 views.
- Produces: `developerModuleKeys`, `usePublisherModuleReleases`, `usePublisherModuleDetail`, `usePublisherModuleHistory`, `useRequestPublisherReview`, `PublisherReleaseListPage`, and `PublisherReleaseDetailPage`.

- [ ] **Step 1: Write failing query-key and page-view tests**

Test exact account isolation and legal-action rendering:

```tsx
expect(developerModuleKeys.list('account-a')).not.toEqual(developerModuleKeys.list('account-b'));
expect(developerModuleKeys.detail('account-a', RELEASE_ID)).not.toEqual(
  developerModuleKeys.detail('account-b', RELEASE_ID),
);
const html = renderToStaticMarkup(
  <PublisherReleaseDetailView
    release={{ ...RELEASE, status: 'validated', review_revision: 3 }}
    history={[]}
    canWrite
    pending={false}
    errorCode={null}
    onRequestReview={() => undefined}
  />,
);
expect(html).toContain('Request review');
expect(html).not.toContain('Approve');
```

Also render loading, empty, filtered, `account.read`-denied, `account.write`-denied,
`changes_requested`, and read-only approved/revoked states. Assert that losing write
permission removes publisher mutations without suppressing rows the caller may still read.

- [ ] **Step 2: Run publisher list/detail tests and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/publisher/query.test.ts src/features/developer-center/publisher/publisher-pages.test.tsx
```

Expected: FAIL because the query and page modules do not exist.

- [ ] **Step 3: Implement account-scoped query hooks**

```typescript
export const developerModuleKeys = {
  account: (accountId: string) => ['developer-modules', 'account', accountId] as const,
  list: (accountId: string) => [...developerModuleKeys.account(accountId), 'list'] as const,
  detail: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'detail', releaseId] as const,
  history: (accountId: string, releaseId: string) =>
    [...developerModuleKeys.account(accountId), 'history', releaseId] as const,
};

export function usePublisherModuleReleases(accountId: string | null) {
  return useQuery({
    queryKey: accountId ? developerModuleKeys.list(accountId) : ['developer-modules', 'idle'],
    queryFn: () => listDeveloperModuleReleases({ accountId: accountId!, limit: 100 }),
    enabled: Boolean(accountId),
    staleTime: 15_000,
  });
}
```

Implement detail/history analogously. The review mutation accepts `{ releaseId, accountId, expectedStatus, expectedRevision, reason }`, calls `requestDeveloperModuleReview`, then sets returned detail data and invalidates list/history. It must not update status before the promise succeeds.

- [ ] **Step 4: Implement list and detail containers plus thin routes**

The list and detail containers read `selectedAccountId` and call
`usePermission(accountId, 'account.read')` before enabling publisher queries. They call
`usePermission(accountId, 'account.write')` independently for Submit, Request review, and
Resubmit capabilities. The list labels the table **Recent releases** and filters only
`data.releases` with Task 1 helpers. An account change must switch to the new account-scoped
query keys before rows render; cached rows from the previous account never serve as
placeholder data.

```tsx
// apps/web/src/app/(app)/developer/modules/page.tsx
import { PublisherReleaseListPage } from '@/features/developer-center/publisher/release-list-page';
export default function Page() { return <PublisherReleaseListPage />; }
```

```tsx
// apps/web/src/app/(app)/developer/modules/[releaseId]/page.tsx
import { PublisherReleaseDetailPage } from '@/features/developer-center/publisher/release-detail-page';
export default async function Page({ params }: { params: Promise<{ releaseId: string }> }) {
  const { releaseId } = await params;
  return <PublisherReleaseDetailPage releaseId={releaseId} />;
}
```

The detail container passes only publisher callbacks to the view. For `validated`, submit `expectedStatus: 'validated'`; for `changes_requested`, submit `expectedStatus: 'changes_requested'` with the bounded resubmission explanation.

- [ ] **Step 5: Run focused publisher tests and TypeScript**

Run the Step 2 command, then:

```powershell
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: all focused tests and TypeScript pass.

- [ ] **Step 6: Commit publisher list/detail**

```powershell
git add -- apps/web/src/features/developer-center/publisher/query.ts apps/web/src/features/developer-center/publisher/query.test.ts apps/web/src/features/developer-center/publisher/release-list-page.tsx apps/web/src/features/developer-center/publisher/release-detail-page.tsx apps/web/src/features/developer-center/publisher/publisher-pages.test.tsx 'apps/web/src/app/(app)/developer/modules/page.tsx' 'apps/web/src/app/(app)/developer/modules/[releaseId]/page.tsx'
git commit -m "feat(web): add publisher module review pages"
```

---

### Task 4: Publisher validate-and-submit flow

**Files:**
- Create: `apps/web/src/features/developer-center/publisher/submit-controller.ts`
- Create: `apps/web/src/features/developer-center/publisher/submit-controller.test.ts`
- Create: `apps/web/src/features/developer-center/publisher/submit-page.tsx`
- Create: `apps/web/src/features/developer-center/publisher/submit-page.test.tsx`
- Create: `apps/web/src/app/(app)/developer/modules/submit/page.tsx`

**Interfaces:**
- Consumes: Task 1 parser and public SDK `validateDeveloperModule` / `submitDeveloperModuleRelease`.
- Produces: `createDeveloperModuleSubmitController`, `DeveloperModuleSubmitView`, and `PublisherModuleSubmitPage`.

- [ ] **Step 1: Write failing controller tests**

Cover:

- malformed JSON makes zero SDK calls;
- more than 1 MiB makes zero SDK calls;
- validation issues keep stage `input` and expose only typed issue paths/messages;
- successful validation moves to `confirm` without persistence;
- confirmation submits exactly the validated object and account ID once;
- editing text after validation clears the confirmation snapshot;
- concurrent confirm clicks share one pending promise.

```typescript
const controller = createDeveloperModuleSubmitController({ validate, submit });
controller.setText(VALID_JSON);
expect(await controller.validate()).toMatchObject({ stage: 'confirm' });
expect(submit).not.toHaveBeenCalled();
const first = controller.confirm(ACCOUNT_ID);
const replay = controller.confirm(ACCOUNT_ID);
expect(submit).toHaveBeenCalledTimes(1);
expect(await first).toEqual(await replay);
```

- [ ] **Step 2: Run controller tests and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/publisher/submit-controller.test.ts
```

Expected: FAIL because the controller is missing.

- [ ] **Step 3: Implement the dependency-injected controller**

The controller stores only in-memory text, the parsed object, validation output, and one pending promise. `setText` always clears the prior parsed snapshot. `confirm(accountId)` throws `SUBMISSION_NOT_VALIDATED` unless the current text produced the current successful validation.

- [ ] **Step 4: Write and run failing submit-view tests**

Static-render tests must cover input, validation issues, confirmation summary, no-write permission, pending submission, and stable errors. Assert that manifest input never appears in links or hidden fields.

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/publisher/submit-page.test.tsx
```

Expected: FAIL before `submit-page.tsx` exists.

- [ ] **Step 5: Implement submit page and route**

The page provides:

- `.json` file input using `file.text()`;
- paste textarea;
- Validate action;
- issue list grouped by severity;
- confirmation summary for publisher ID, module ID, version, execution mode, permissions, and review requirements;
- Submit action gated by `account.write`;
- redirect to `/developer/modules/{releaseId}` after success.

```tsx
// apps/web/src/app/(app)/developer/modules/submit/page.tsx
import { PublisherModuleSubmitPage } from '@/features/developer-center/publisher/submit-page';
export default function Page() { return <PublisherModuleSubmitPage />; }
```

- [ ] **Step 6: Run submit tests, all publisher tests, and TypeScript**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/publisher
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit submit flow**

```powershell
git add -- apps/web/src/features/developer-center/publisher/submit-controller.ts apps/web/src/features/developer-center/publisher/submit-controller.test.ts apps/web/src/features/developer-center/publisher/submit-page.tsx apps/web/src/features/developer-center/publisher/submit-page.test.tsx 'apps/web/src/app/(app)/developer/modules/submit/page.tsx'
git commit -m "feat(web): add module validation and submission flow"
```

---

### Task 5: Private Admin transport, query hooks, and evidence model

**Files:**
- Create: `apps/web/src/features/developer-center/admin/client.ts`
- Create: `apps/web/src/features/developer-center/admin/client.test.ts`
- Create: `apps/web/src/features/developer-center/admin/query.ts`
- Create: `apps/web/src/features/developer-center/admin/evidence.ts`
- Create: `apps/web/src/features/developer-center/admin/evidence.test.ts`

**Interfaces:**
- Consumes: `backendApi` from `@/lib/api-client` and SDK release/event/evidence types.
- Produces: `listAdminDeveloperReviews`, `getAdminDeveloperReview`, `decideAdminDeveloperReview`, `adminDeveloperReviewKeys`, `useAdminDeveloperReviewQueue`, `useAdminDeveloperReviewDetail`, `useAdminDeveloperReviewDecision`, `createEvidenceDrafts`, `isApprovalEvidenceComplete`, and `buildAdminDecisionBody`.

- [ ] **Step 1: Write failing Admin client contract tests**

Mock `backendApi` and assert exact private paths and bodies:

```typescript
expect(get).toHaveBeenCalledWith('/admin/developer/modules/reviews?status=review_pending&limit=50');
expect(get).toHaveBeenCalledWith(`/admin/developer/modules/releases/${RELEASE_ID}/review`);
expect(post).toHaveBeenCalledWith(
  `/admin/developer/modules/releases/${RELEASE_ID}/review-decisions`,
  {
    decision: 'approve',
    expected_status: 'review_pending',
    expected_revision: 4,
    evidence: COMPLETE_EVIDENCE,
  },
);
```

Also assert `cursor` is URL-encoded and response errors throw only stable codes.

- [ ] **Step 2: Run Admin client tests and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/admin/client.test.ts
```

Expected: FAIL because `client.ts` is missing.

- [ ] **Step 3: Implement the private Admin client**

```typescript
export async function listAdminDeveloperReviews(input: {
  status: DeveloperModuleReleaseStatus;
  limit?: number;
  cursor?: string | null;
}): Promise<AdminDeveloperReviewPage> {
  const query = new URLSearchParams({ status: input.status, limit: String(input.limit ?? 50) });
  if (input.cursor) query.set('cursor', input.cursor);
  return unwrapAdmin(
    await backendApi.get<AdminDeveloperReviewPage>(`/admin/developer/modules/reviews?${query}`),
  );
}
```

Implement detail and decision methods with the exact routes from the design. Keep this file under the Web Admin feature and do not export it from `@kortix/sdk`.

- [ ] **Step 4: Write failing evidence-model tests**

Cover exactly one evidence entry per declared requirement, fixed `manual/passed`, 1,000-character summaries, optional tool metadata, SHA-256 digest validation, required reason for request changes/revoke, and no evidence on request-changes payloads.

```typescript
expect(isApprovalEvidenceComplete(['manifest_review', 'human_review'], COMPLETE_EVIDENCE)).toBe(true);
expect(isApprovalEvidenceComplete(['manifest_review', 'human_review'], COMPLETE_EVIDENCE.slice(0, 1))).toBe(false);
expect(() => buildAdminDecisionBody(RELEASE, 'revoke', { reason: ' ' })).toThrow('REASON_REQUIRED');
```

- [ ] **Step 5: Implement evidence helpers and Admin query hooks**

Admin query keys must be:

```typescript
export const adminDeveloperReviewKeys = {
  all: ['admin-developer-reviews'] as const,
  list: (status: DeveloperModuleReleaseStatus, cursor: string | null) =>
    ['admin-developer-reviews', 'list', status, cursor ?? 'first'] as const,
  detail: (releaseId: string) => ['admin-developer-reviews', 'detail', releaseId] as const,
};
```

The decision hook sends current `status` / `review_revision`, updates detail only after success, then invalidates the old and new status queues. On stable conflict, it removes stale detail, refetches detail, and rethrows `DEVELOPER_REVIEW_CONFLICT`; it does not retry the POST.

- [ ] **Step 6: Run Admin model/client tests and TypeScript**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/admin/client.test.ts src/features/developer-center/admin/evidence.test.ts
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Admin data boundary**

```powershell
git add -- apps/web/src/features/developer-center/admin/client.ts apps/web/src/features/developer-center/admin/client.test.ts apps/web/src/features/developer-center/admin/query.ts apps/web/src/features/developer-center/admin/evidence.ts apps/web/src/features/developer-center/admin/evidence.test.ts
git commit -m "feat(web): add private admin module review client"
```

---

### Task 6: Admin review queue and decision detail pages

**Files:**
- Create: `apps/web/src/features/developer-center/admin/review-queue-page.tsx`
- Create: `apps/web/src/features/developer-center/admin/review-detail-page.tsx`
- Create: `apps/web/src/features/developer-center/admin/admin-pages.test.tsx`
- Create: `apps/web/src/app/admin/developer-reviews/page.tsx`
- Create: `apps/web/src/app/admin/developer-reviews/[releaseId]/page.tsx`

**Interfaces:**
- Consumes: Task 2 shared views and Task 5 Admin hooks/evidence helpers.
- Produces: `AdminDeveloperReviewQueuePage`, `AdminDeveloperReviewDetailPage`, and privilege-specific view components.

- [ ] **Step 1: Write failing Admin page-view tests**

Render and assert:

- default `review_pending` tab;
- loaded-page search and deterministic standard/elevated indicators;
- cursor next action only when `next_cursor` exists;
- malformed-cursor errors produce the localized recoverable queue state and reset-to-first-page action;
- complete evidence enables Approve;
- incomplete evidence disables Approve;
- Request changes and Revoke require reasons;
- Revoke dialog names module ID and version;
- conflict state says the release changed and offers reload, without a retry button for the old decision;
- no Admin callback appears in publisher source or bundle imports.

- [ ] **Step 2: Run Admin page tests and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/admin/admin-pages.test.tsx
```

Expected: FAIL because the pages are missing.

- [ ] **Step 3: Implement the queue page**

Use existing Admin `SectionContainer`, `SectionHeader`, `Table`, `Badge`, `Input`, `Button`, and empty-state primitives. Status tabs update local state and reset cursor. Selecting a row uses `router.push('/admin/developer-reviews/{releaseId}')`.

- [ ] **Step 4: Implement the detail and decision forms**

The detail view separates:

1. lifecycle and manifest summary;
2. one controlled evidence editor per declared requirement;
3. decision controls;
4. immutable timeline.

Approval posts only `approve` plus complete evidence. Request changes posts only a required reason. Revoke uses `AlertDialog`, names the module/version, and posts the required reason. Disable all decision controls while a mutation is pending.

- [ ] **Step 5: Add thin Admin routes**

```tsx
// apps/web/src/app/admin/developer-reviews/page.tsx
import { AdminDeveloperReviewQueuePage } from '@/features/developer-center/admin/review-queue-page';
export default function Page() { return <AdminDeveloperReviewQueuePage />; }
```

```tsx
// apps/web/src/app/admin/developer-reviews/[releaseId]/page.tsx
import { AdminDeveloperReviewDetailPage } from '@/features/developer-center/admin/review-detail-page';
export default async function Page({ params }: { params: Promise<{ releaseId: string }> }) {
  const { releaseId } = await params;
  return <AdminDeveloperReviewDetailPage releaseId={releaseId} />;
}
```

- [ ] **Step 6: Run Admin tests and TypeScript**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/admin
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Admin pages**

```powershell
git add -- apps/web/src/features/developer-center/admin/review-queue-page.tsx apps/web/src/features/developer-center/admin/review-detail-page.tsx apps/web/src/features/developer-center/admin/admin-pages.test.tsx apps/web/src/app/admin/developer-reviews/page.tsx 'apps/web/src/app/admin/developer-reviews/[releaseId]/page.tsx'
git commit -m "feat(web): add admin module review workbench"
```

---

### Task 7: Navigation and localization integration

**Files:**
- Modify: `apps/web/src/features/layout/user-menu.tsx`
- Modify: `apps/web/src/app/admin/_components/admin-sidebar.tsx`
- Create: `apps/web/src/features/developer-center/navigation.test.ts`
- Create: `apps/web/src/features/developer-center/labels.ts`
- Modify: `apps/web/translations/en.json`
- Modify: `apps/web/translations/zh.json`
- Modify: `apps/web/translations/de.json`
- Modify: `apps/web/translations/es.json`
- Modify: `apps/web/translations/fr.json`
- Modify: `apps/web/translations/it.json`
- Modify: `apps/web/translations/ja.json`
- Modify: `apps/web/translations/pt.json`

**Interfaces:**
- Consumes: existing `useTranslations`, User Menu, and Admin Sidebar conventions.
- Produces: discoverable publisher/Admin routes and typed `developerCenter` copy.

- [ ] **Step 1: Write failing navigation/localization contract tests**

The test reads the two navigation sources and translation JSON files, then asserts:

```typescript
expect(userMenuSource).toContain("router.push('/developer/modules')");
expect(adminSidebarSource).toContain("href: '/admin/developer-reviews'");
for (const locale of ['en', 'zh', 'de', 'es', 'fr', 'it', 'ja', 'pt']) {
  const messages = JSON.parse(await Bun.file(`translations/${locale}.json`).text());
  expect(messages.developerCenter.publisher.recentReleases).toBeString();
  expect(messages.developerCenter.admin.moduleReviews).toBeString();
  expect(messages.developerCenter.errors.DEVELOPER_REVIEW_CONFLICT).toBeString();
}
```

- [ ] **Step 2: Run the navigation test and confirm RED**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/navigation.test.ts
```

Expected: FAIL because routes and message namespaces are absent.

- [ ] **Step 3: Add minimal navigation entries**

Add one User Menu item immediately after Marketplace:

```tsx
<DropdownMenuItem onClick={() => deferAfterClose(() => router.push('/developer/modules'))}>
  <PackageOpen />
  {tDeveloperCenter('publisher.title')}
</DropdownMenuItem>
```

Add one Admin Sidebar item after Accounts:

```typescript
{
  href: '/admin/developer-reviews',
  label: tDeveloperCenter('admin.moduleReviews'),
  icon: PackageCheck,
},
```

Do not restructure either navigation component.

- [ ] **Step 4: Add the exact translation namespace**

Every locale must contain this shape; `en` is the canonical fallback copy, `zh` contains Chinese copy, and the remaining locales may use the canonical English strings until product translation review:

```json
{
  "developerCenter": {
    "publisher": {
      "title": "Developer Center",
      "recentReleases": "Recent releases",
      "submitNewVersion": "Submit new version",
      "requestReview": "Request review",
      "resubmit": "Resubmit for review"
    },
    "admin": {
      "moduleReviews": "Module reviews",
      "reviewQueue": "Review queue",
      "requestChanges": "Request changes",
      "approve": "Approve",
      "revoke": "Emergency revoke"
    },
    "errors": {
      "DEVELOPER_REQUEST_FAILED": "The request failed. Try again.",
      "DEVELOPER_MODULE_INVALID": "The module manifest is invalid.",
      "DEVELOPER_PUBLISHER_MISMATCH": "The module ID does not match the publisher namespace.",
      "DEVELOPER_PUBLISHER_CONFLICT": "This publisher belongs to another account.",
      "DEVELOPER_MODULE_VERSION_CONFLICT": "This version already exists with different content.",
      "DEVELOPER_RELEASE_NOT_FOUND": "The release was not found.",
      "DEVELOPER_REVIEW_REASON_REQUIRED": "Enter a reason.",
      "DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE": "Complete evidence for every review requirement.",
      "DEVELOPER_REVIEW_SELF_APPROVAL_DENIED": "An independent administrator must approve this release.",
      "DEVELOPER_REVIEW_TRANSITION_INVALID": "The release is no longer in a valid state for this action.",
      "DEVELOPER_REVIEW_CONFLICT": "Another administrator updated this release. Review the latest state and submit again."
    }
  }
}
```

- [ ] **Step 5: Run navigation, i18n audit, and TypeScript**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center/navigation.test.ts
pnpm --filter Kortix-Computer-Frontend i18n:audit
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit navigation and localization**

```powershell
git add -- apps/web/src/features/layout/user-menu.tsx apps/web/src/app/admin/_components/admin-sidebar.tsx apps/web/src/features/developer-center/navigation.test.ts apps/web/src/features/developer-center/labels.ts apps/web/translations/en.json apps/web/translations/zh.json apps/web/translations/de.json apps/web/translations/es.json apps/web/translations/fr.json apps/web/translations/it.json apps/web/translations/ja.json apps/web/translations/pt.json
git commit -m "feat(web): expose developer center navigation"
```

---

### Task 8: Deterministic browser acceptance harness

**Files:**
- Create: `apps/web/src/app/(system)/debug/developer-center/page.tsx`
- Create: `apps/web/scripts/e2e/developer-center-review-smoke.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: production publisher/Admin page components and existing `setBootstrapAuthToken` debug convention.
- Produces: `/debug/developer-center` and `test:e2e:developer-center`.

- [ ] **Step 1: Add a failing package-script contract test to the smoke preflight**

At script startup, assert that the debug page source imports the production publisher and Admin components, and fail if it contains duplicated lifecycle status maps.

- [ ] **Step 2: Implement the debug surface**

Follow the existing Image Studio debug convention:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { setBootstrapAuthToken } from '@/lib/auth-token';
import { useCurrentAccountStore } from '@/stores/current-account-store';

const DEBUG_ACCOUNT_ID = '21000000-0000-4000-a000-000000000001';

export default function DebugDeveloperCenterPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setBootstrapAuthToken('debug-developer-center-token');
    useCurrentAccountStore.getState().setSelectedAccountId(DEBUG_ACCOUNT_ID);
    setReady(true);
    return () => setBootstrapAuthToken(null);
  }, []);
  if (!ready) return null;
  return <DeveloperCenterDebugHarness />;
}
```

`DeveloperCenterDebugHarness` offers buttons for publisher list, submit, publisher detail, Admin queue, and Admin detail while rendering the same production feature components.

- [ ] **Step 3: Implement intercepted API scenarios**

The Playwright script must intercept all `/v1/developer/modules/**` and `/v1/admin/developer/modules/**` calls, assert the debug bearer token, and fail on any unrecognized Developer Center request. It records request payloads for validation, submission, review request, request changes, approval, revoke, and one forced 409 conflict.

Stable fixture IDs use valid UUIDs. Approval fixtures include one evidence entry for every requirement. No fixture contains a secret-looking value.

- [ ] **Step 4: Implement named visible browser assertions**

The smoke must visibly exercise and assert:

1. recent publisher list and loaded-result filtering;
2. malformed JSON blocked before HTTP;
3. valid JSON validation then explicit confirmation;
4. submitted release deep-link detail;
5. request review with exact status/revision;
6. Admin queue status/cursor navigation;
7. incomplete evidence keeps Approve disabled;
8. complete evidence posts exactly once;
9. request-changes reason;
10. named emergency-revoke confirmation;
11. forced 409 refreshes detail and does not replay;
12. direct publisher and Admin detail URLs render current intercepted state after reload;
13. browser back and forward restore the list/queue and independent detail pages;
14. switching between two fixture accounts issues the new account ID, never reuses the prior
    account's rows, and preserves `account.read` / `account.write` capability differences;
15. malformed Admin cursor shows the recoverable reset-to-first-page state;
16. no Video, Voice, 3D, Digital Human, or Batch Remix text;
17. no unexpected console errors or page errors;
18. desktop screenshot is nonblank and has no horizontal overflow.

- [ ] **Step 5: Add the package command and run against a local Web server**

Add:

```json
"test:e2e:developer-center": "node --experimental-strip-types scripts/e2e/developer-center-review-smoke.ts"
```

Start Web on an unused port in a managed background process, then run:

```powershell
$env:WEB_PORT='3312'
pnpm --filter Kortix-Computer-Frontend dev
```

In a second process:

```powershell
$env:WEB_BASE_URL='http://127.0.0.1:3312'
pnpm --filter Kortix-Computer-Frontend test:e2e:developer-center
```

Expected: smoke exits 0, writes a nonblank screenshot under the existing E2E results directory, and the managed Web child tree is stopped afterward with port 3312 closed.

- [ ] **Step 6: Commit browser acceptance**

```powershell
git add -- 'apps/web/src/app/(system)/debug/developer-center/page.tsx' apps/web/scripts/e2e/developer-center-review-smoke.ts apps/web/package.json
git commit -m "test(web): cover developer center review flows"
```

---

### Task 9: Full Web gates, repository baseline, and progress ledger

**Files:**
- Modify: `docs/operations/studio-acceleration-progress.md`

**Interfaces:**
- Consumes: every preceding task and the existing progress-ledger truthfulness rules.
- Produces: final verification evidence and an accurate Developer Center status entry.

- [ ] **Step 1: Run all focused Developer Center tests**

```powershell
pnpm --filter Kortix-Computer-Frontend exec bun test src/features/developer-center
```

Expected: all new tests pass.

- [ ] **Step 2: Run the complete Web package suite**

```powershell
pnpm --filter Kortix-Computer-Frontend test
```

Expected: all Web tests pass. Record the fresh count in the progress ledger; do not reuse an older count.

- [ ] **Step 3: Run static gates**

```powershell
pnpm --filter Kortix-Computer-Frontend exec tsc --noEmit
pnpm --filter Kortix-Computer-Frontend i18n:audit
pnpm exec biome check apps/web/src/features/developer-center apps/web/src/app/admin/developer-reviews 'apps/web/src/app/(app)/developer/modules' 'apps/web/src/app/(system)/debug/developer-center/page.tsx' apps/web/scripts/e2e/developer-center-review-smoke.ts apps/web/src/features/layout/user-menu.tsx apps/web/src/app/admin/_components/admin-sidebar.tsx apps/web/package.json
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Rerun deterministic browser acceptance**

Run Task 8 Step 5 with a freshly started server and closed port afterward.

Expected: all named browser flows pass. Label this as mocked-contract browser evidence, not live database evidence.

- [ ] **Step 5: Attempt the root repository suite as a baseline comparison**

```powershell
pnpm test
```

Expected on this Windows host: the unchanged `@kortix/sandbox-agent-server` POSIX/Unix fixture failures may remain. Record exact fresh counts and first failure. Do not claim a full repository pass unless every workspace package actually passes.

- [ ] **Step 6: Attempt live authenticated acceptance only when dependencies are available**

Check local Supabase/PostgreSQL readiness first. If unavailable, record the exact blocker and do not substitute the debug smoke as live proof. If available, visibly verify publisher submit/request/resubmit and Admin request-changes/approve/revoke against the real API and database.

- [ ] **Step 7: Update the progress ledger with exact evidence**

Update the Developer Center row to **Web publisher/Admin manual-review UI implemented** only after Steps 1-4 pass. Add a dated section that separates:

- focused and complete Web test counts;
- TypeScript, i18n, Biome, and diff gates;
- mocked-contract browser results;
- root-suite baseline result;
- live database/auth result or exact blocker;
- still-open automated scan, signing, publication, install/rollback, metering, settlement, and production acceptance.

- [ ] **Step 8: Commit the verified ledger**

```powershell
git add -- docs/operations/studio-acceleration-progress.md
git commit -m "docs: record developer center web acceptance"
```

- [ ] **Step 9: Verify final commit and protected-file boundaries**

```powershell
git status --short
git log --oneline -10
git diff HEAD~9..HEAD --check
```

Expected: only the two protected pre-existing untracked documents remain; no `.superpowers` visual-companion files, generated screenshots, secrets, or unrelated files are staged or committed.

## Plan Self-review Checklist

- [x] Every design goal maps to at least one task.
- [x] Publisher and Admin clients are separate; Admin methods never enter the public SDK.
- [x] Every mutation uses server-returned status/revision and every 409 path avoids replay.
- [x] The 1 MiB input bound, recent-100 wording, account cache isolation, and evidence completeness rules are explicit.
- [x] All five production pages and both navigation entries have named tasks.
- [x] All eight translation catalogs receive the same required namespace shape.
- [x] Browser evidence is explicitly distinguished from live auth/database evidence.
- [x] No task modifies Review Center, backend lifecycle rules, database schema, or cancelled multimedia pages.
- [x] Every implementation task has a RED command, GREEN command, and focused commit.
- [x] Protected untracked documents remain outside every `git add` command.
