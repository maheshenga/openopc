import { expect, test } from 'bun:test';

type WorkflowStep = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
};

type Workflow = {
  on: { workflow_dispatch: null };
  permissions: Record<string, never>;
  jobs: Record<string, WorkflowJob>;
};

async function parseWorkflow(path: string): Promise<{ source: string; workflow: Workflow }> {
  const source = await Bun.file(path).text();
  return { source, workflow: Bun.YAML.parse(source) as Workflow };
}

function actionSteps(job: WorkflowJob, action: string): WorkflowStep[] {
  return job.steps.filter((step) => step.uses === action);
}

function step(job: WorkflowJob, id: string): WorkflowStep {
  const found = job.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing workflow step: ${id}`);
  return found;
}

function assertComparedSubjectBindings(run: string): void {
  const bindings = [
    "test \"$(jq -er '.digest' _cosign-compared/linux-compared.json)\" = \"$linux_digest\" || { echo 'digest-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.sizeBytes' _cosign-compared/linux-compared.json)\" = \"$linux_size\" || { echo 'size-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.digest' _cosign-compared/windows-compared.json)\" = \"$windows_digest\" || { echo 'digest-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.sizeBytes' _cosign-compared/windows-compared.json)\" = \"$windows_size\" || { echo 'size-mismatch: error'; exit 1; }",
  ];
  for (const binding of bindings) {
    if (!run.split('\n').includes(binding)) {
      throw new Error(`Missing compared subject binding: ${binding}`);
    }
  }
}

const WORKFLOW = '.github/workflows/openopc-cosign-builder.yml';
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_BUN = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const DOWNLOAD = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const ATTEST = 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d';
const GUARD = "github.repository == 'openopc/platform' && github.ref == 'refs/heads/main' && github.workflow_sha == github.sha";

test('cosign builder uses a no-input protected manual trigger and exact job graph', async () => {
  const { source, workflow } = await parseWorkflow(WORKFLOW);
  expect(workflow.on).toEqual({ workflow_dispatch: null });
  expect(Object.keys(workflow.jobs)).toEqual([
    'primary',
    'replay',
    'compare_attest',
    'linux_smoke',
    'windows_smoke',
    'promote',
  ]);
  expect(source).toContain("github.repository == 'openopc/platform'");
  expect(source).toContain("github.ref == 'refs/heads/main'");
  expect(source).toContain('github.workflow_sha');
  expect(source).not.toContain('pull_request_target');
  expect(source).not.toContain('continue-on-error');
  expect(source).not.toContain('secrets.');
});

test('cosign builder isolates attestation and promotion permissions', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.primary.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.replay.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.compare_attest.permissions).toEqual({
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
  });
  expect(workflow.jobs.linux_smoke.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.windows_smoke.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.promote.permissions).toEqual({ actions: 'read', contents: 'write' });
  expect(workflow.jobs.promote.environment).toBe('toolchain-release');
});

test('cosign builder guards every job by the protected repository, ref, and workflow SHA', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    expect(job.if, name).toBe(GUARD);
  }
});

test('cosign builder pins control and upstream checkouts for both isolated builds', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  for (const name of ['primary', 'replay'] as const) {
    const checkouts = actionSteps(workflow.jobs[name], CHECKOUT);
    expect(checkouts).toHaveLength(2);
    expect(checkouts[0]?.with).toMatchObject({ ref: '${{ github.workflow_sha }}', 'persist-credentials': false });
    expect(checkouts[1]?.with).toMatchObject({ repository: 'sigstore/cosign', ref: '193d2153431f8bb0d945a4c1ee721872f73add67', 'persist-credentials': false });
    expect(actionSteps(workflow.jobs[name], SETUP_BUN)[0]?.with).toEqual({ 'bun-version': '1.3.14' });
  }
});

test('cosign builder uses immutable artifact actions and no-overwrite upload contracts', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  for (const name of ['primary', 'replay', 'compare_attest', 'promote'] as const) {
    const uploads = actionSteps(workflow.jobs[name], UPLOAD);
    expect(uploads.length, name).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(upload.with).toMatchObject({ 'if-no-files-found': 'error', overwrite: false });
      expect(typeof upload.with?.['retention-days']).toBe('number');
    }
  }
  for (const name of ['compare_attest', 'linux_smoke', 'windows_smoke', 'promote'] as const) {
    const downloads = actionSteps(workflow.jobs[name], DOWNLOAD);
    expect(downloads.length, name).toBeGreaterThan(0);
    for (const download of downloads) {
      expect(download.with?.['artifact-ids'], name).toMatch(/^\$\{\{ needs\.[a-z_]+\.outputs\.artifact-id \}\}$/);
      expect(download.with?.['merge-multiple'], name).toBe(true);
      expect(download.with?.name, name).toBeUndefined();
      expect(download.with?.pattern, name).toBeUndefined();
    }
  }

  expect(step(workflow.jobs.compare_attest, 'upload').with?.name).toBe(
    'openopc-cosign-prepromotion-v3.1.2.1-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  expect(step(workflow.jobs.promote, 'upload-final').with?.name).toBe(
    'openopc-cosign-toolchain-v3.1.2.1',
  );

  const allowed = new Set([CHECKOUT, SETUP_BUN, UPLOAD, DOWNLOAD, ATTEST]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const action of job.steps.filter((candidate) => candidate.uses)) {
      expect(allowed.has(action.uses as string), `${name}: ${action.uses}`).toBe(true);
    }
  }
});

test('cosign builder creates every bind output root before either protected build', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  expect(step(workflow.jobs.primary, 'build').run).toContain(
    'mkdir -p _primary/linux _primary/windows _primary-module-cache',
  );
  expect(step(workflow.jobs.replay, 'build').run).toContain(
    'mkdir -p _replay/linux _replay/windows _replay-module-cache',
  );
});

test('cosign builder compares both replay subjects byte-for-byte before attesting', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const comparison = step(workflow.jobs.compare_attest, 'compare');
  expect(comparison.run).toContain('cmp -- _primary/cosign-linux-amd64 _replay/cosign-linux-amd64');
  expect(comparison.run).toContain('cmp -- _primary/cosign-windows-amd64.exe _replay/cosign-windows-amd64.exe');
  expect(comparison.run).toContain('public-beta-cosign-builder.ts predicate');
  expect(comparison.run).toContain('sha256sum _cosign-compared/cosign-linux-amd64');
  expect(comparison.run).toContain('sha256sum _cosign-compared/cosign-windows-amd64.exe');
  expect(comparison.run).toContain("wc -c < _cosign-compared/cosign-linux-amd64");
  expect(comparison.run).toContain("wc -c < _cosign-compared/cosign-windows-amd64.exe");
  expect(step(workflow.jobs.compare_attest, 'retain-bundles').run).toContain('prepromotion.json');
});

test('cosign builder rejects every mutation that removes a retained subject digest or size binding', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const comparison = step(workflow.jobs.compare_attest, 'compare');
  const run = comparison.run;
  if (!run) throw new Error('Missing compare script');
  assertComparedSubjectBindings(run);
  for (const binding of [
    "test \"$(jq -er '.digest' _cosign-compared/linux-compared.json)\" = \"$linux_digest\" || { echo 'digest-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.sizeBytes' _cosign-compared/linux-compared.json)\" = \"$linux_size\" || { echo 'size-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.digest' _cosign-compared/windows-compared.json)\" = \"$windows_digest\" || { echo 'digest-mismatch: error'; exit 1; }",
    "test \"$(jq -er '.sizeBytes' _cosign-compared/windows-compared.json)\" = \"$windows_size\" || { echo 'size-mismatch: error'; exit 1; }",
  ]) {
    expect(() => assertComparedSubjectBindings(run.replace(binding, ''))).toThrow(
      'Missing compared subject binding',
    );
  }
});

test('cosign builder locks every artifact producer, output, and exact-ID consumer edge', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  expect(workflow.jobs.primary.outputs).toEqual({ 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' });
  expect(workflow.jobs.replay.outputs).toEqual({ 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' });
  expect(workflow.jobs.compare_attest.outputs).toEqual({ 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' });
  expect(workflow.jobs.linux_smoke.outputs).toEqual({ 'artifact-id': '${{ needs.compare_attest.outputs.artifact-id }}' });
  expect(workflow.jobs.windows_smoke.outputs).toEqual({ 'artifact-id': '${{ needs.compare_attest.outputs.artifact-id }}' });
  expect(actionSteps(workflow.jobs.compare_attest, DOWNLOAD).map((item) => item.with)).toEqual([
    { 'artifact-ids': '${{ needs.primary.outputs.artifact-id }}', path: '_primary', 'merge-multiple': true },
    { 'artifact-ids': '${{ needs.replay.outputs.artifact-id }}', path: '_replay', 'merge-multiple': true },
  ]);
  expect(actionSteps(workflow.jobs.linux_smoke, DOWNLOAD)[0]?.with).toEqual({
    'artifact-ids': '${{ needs.compare_attest.outputs.artifact-id }}', path: '_cosign-compared', 'merge-multiple': true,
  });
  expect(actionSteps(workflow.jobs.windows_smoke, DOWNLOAD)[0]?.with).toEqual({
    'artifact-ids': '${{ needs.compare_attest.outputs.artifact-id }}', path: '_cosign-compared', 'merge-multiple': true,
  });
  expect(actionSteps(workflow.jobs.promote, DOWNLOAD)[0]?.with).toEqual({
    'artifact-ids': '${{ needs.linux_smoke.outputs.artifact-id }}', path: '_cosign-compared', 'merge-multiple': true,
  });
});

function assertExactArtifactIdChain(workflow: Workflow): void {
  const expected = [
    [workflow.jobs.primary.outputs, { 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' }],
    [workflow.jobs.replay.outputs, { 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' }],
    [workflow.jobs.compare_attest.outputs, { 'artifact-id': '${{ steps.upload.outputs.artifact-id }}' }],
    [workflow.jobs.linux_smoke.outputs, { 'artifact-id': '${{ needs.compare_attest.outputs.artifact-id }}' }],
    [workflow.jobs.windows_smoke.outputs, { 'artifact-id': '${{ needs.compare_attest.outputs.artifact-id }}' }],
    [actionSteps(workflow.jobs.compare_attest, DOWNLOAD).map((item) => item.with?.['artifact-ids']), ['${{ needs.primary.outputs.artifact-id }}', '${{ needs.replay.outputs.artifact-id }}']],
    [actionSteps(workflow.jobs.linux_smoke, DOWNLOAD).map((item) => item.with?.['artifact-ids']), ['${{ needs.compare_attest.outputs.artifact-id }}']],
    [actionSteps(workflow.jobs.windows_smoke, DOWNLOAD).map((item) => item.with?.['artifact-ids']), ['${{ needs.compare_attest.outputs.artifact-id }}']],
    [actionSteps(workflow.jobs.promote, DOWNLOAD).map((item) => item.with?.['artifact-ids']), ['${{ needs.linux_smoke.outputs.artifact-id }}']],
  ];
  for (const [actual, expectedValue] of expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expectedValue)) {
      throw new Error('OPENOPC_COSIGN_ARTIFACT_ID_CHAIN_INVALID');
    }
  }
}

function mutateArtifactId(
  workflow: Workflow,
  job: keyof Workflow['jobs'],
  index: number,
  artifactId: string,
): void {
  const download = actionSteps(workflow.jobs[job], DOWNLOAD)[index];
  if (!download?.with) throw new Error('TEST_COSIGN_ARTIFACT_DOWNLOAD_INVALID');
  download.with['artifact-ids'] = artifactId;
}

test('cosign builder rejects swapped, duplicated, and wrong-upstream artifact-ID mutations', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  assertExactArtifactIdChain(workflow);
  const mutations: Array<(value: Workflow) => void> = [
    (value) => {
      mutateArtifactId(value, 'compare_attest', 0, '${{ needs.replay.outputs.artifact-id }}');
      mutateArtifactId(value, 'compare_attest', 1, '${{ needs.primary.outputs.artifact-id }}');
      expect(
        actionSteps(value.jobs.compare_attest, DOWNLOAD).map(
          (download) => download.with?.['artifact-ids'],
        ),
      ).toEqual([
        '${{ needs.replay.outputs.artifact-id }}',
        '${{ needs.primary.outputs.artifact-id }}',
      ]);
    },
    (value) => mutateArtifactId(value, 'compare_attest', 0, '${{ needs.replay.outputs.artifact-id }}'),
    (value) => mutateArtifactId(value, 'compare_attest', 1, '${{ needs.primary.outputs.artifact-id }}'),
    (value) => mutateArtifactId(value, 'linux_smoke', 0, '${{ needs.replay.outputs.artifact-id }}'),
    (value) => mutateArtifactId(value, 'promote', 0, '${{ needs.windows_smoke.outputs.artifact-id }}'),
  ];
  expect(mutations).toHaveLength(5);
  for (const mutate of mutations) {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    expect(() => assertExactArtifactIdChain(candidate)).toThrow('OPENOPC_COSIGN_ARTIFACT_ID_CHAIN_INVALID');
  }
});

test('cosign builder produces two fixed SLSA attestations and retains both bundles', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const attests = actionSteps(workflow.jobs.compare_attest, ATTEST);
  expect(attests).toHaveLength(2);
  expect(attests[0]).toMatchObject({ id: 'attest-linux', with: {
    'subject-path': '_cosign-compared/cosign-linux-amd64',
    'predicate-type': 'https://slsa.dev/provenance/v1',
    'predicate-path': '_cosign-compared/cosign-linux-amd64.predicate.json',
    'show-summary': false,
  } });
  expect(attests[1]).toMatchObject({ id: 'attest-windows', with: {
    'subject-path': '_cosign-compared/cosign-windows-amd64.exe',
    'predicate-type': 'https://slsa.dev/provenance/v1',
    'predicate-path': '_cosign-compared/cosign-windows-amd64.predicate.json',
    'show-summary': false,
  } });
  const bundles = step(workflow.jobs.compare_attest, 'retain-bundles');
  expect(bundles.run).toContain("steps.attest-linux.outputs.bundle-path");
  expect(bundles.run).toContain("steps.attest-windows.outputs.bundle-path");
  expect(bundles.run).toContain('linux-amd64.jsonl');
  expect(bundles.run).toContain('windows-amd64.jsonl');
});

test('cosign builder runs native Linux and Windows verification without remote signing', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const linux = step(workflow.jobs.linux_smoke, 'smoke');
  const windows = step(workflow.jobs.windows_smoke, 'smoke');
  expect(linux.run).toContain('./_cosign-compared/cosign-linux-amd64 version');
  expect(linux.run).toContain('sign-blob');
  expect(linux.run).toContain('--tlog-upload=false');
  expect(linux.run).toContain('verify-blob');
  expect(windows.run).toContain('& .\\_cosign-compared\\cosign-windows-amd64.exe version');
  expect(windows.run).toContain('sign-blob');
  expect(windows.run).toContain('--tlog-upload=false');
  expect(windows.run).toContain('verify-blob');
  expect((windows.run?.match(/if \(\$LASTEXITCODE -ne 0\)/g) ?? [])).toHaveLength(4);
});

test('cosign builder creates an approved draft, captures release asset IDs, and publishes one final manifest', async () => {
  const { source, workflow } = await parseWorkflow(WORKFLOW);
  expect(workflow.jobs.promote.needs).toEqual(['linux_smoke', 'windows_smoke']);
  const promotion = step(workflow.jobs.promote, 'promote');
  expect(promotion.run).toContain('openopc-cosign-v3.1.2.1');
  expect(promotion.run).toContain('/git/ref/tags/openopc-cosign-v3.1.2.1');
  expect(promotion.run).toContain('HTTP/[0-9.]+ 404');
  expect(promotion.run).toContain('draft=true');
  expect(promotion.run).toContain('cosign-linux-amd64.asset.json');
  expect(promotion.run).toContain('cosign-windows-amd64.exe.asset.json');
  expect(promotion.run).toContain('LINUX_ASSET_ID');
  expect(promotion.run).toContain('WINDOWS_ASSET_ID');
  expect(promotion.run).toContain('releaseAssetId');
  expect(promotion.run).toContain('parsePublicBetaCosignToolchain');
  expect(promotion.run).toContain('canonicalPublicBetaJson');
  expect(promotion.run).toContain('manifest.json');
  expect(step(workflow.jobs.promote, 'publish').run).toContain('draft=false');
  expect(promotion.run).not.toContain('PRIMARY_ARTIFACT_ID');
  expect(promotion.run).not.toContain('REPLAY_ARTIFACT_ID');
  expect(promotion.run).not.toContain('gh release create');
  expect(promotion.run).not.toContain('--clobber');
  expect(source).not.toContain('--clobber');
});

test('cosign builder atomically claims and repeatedly binds the protected lightweight tag before publication', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const promotion = step(workflow.jobs.promote, 'promote');
  const publication = step(workflow.jobs.promote, 'publish');
  expect(promotion.run).toContain('gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs"');
  expect(promotion.run).toContain('ref="refs/tags/$TOOLCHAIN_ID"');
  expect(promotion.run).toContain('sha="$WORKFLOW_SHA"');
  expect(promotion.run).toContain('_claimed-tag-verified.json');
  expect(promotion.run).toContain('object.type == "commit"');
  expect(publication.run).toContain('_prepublish-tag.json');
  expect(publication.run).toContain('object.type == "commit"');
  expect(publication.run).toContain('_published-tag.json');
});

test('cosign builder rebinds all five final draft assets to captured IDs, exact bytes, and the manifest before publication', async () => {
  const { workflow } = await parseWorkflow(WORKFLOW);
  const publication = step(workflow.jobs.promote, 'publish');
  expect(publication.run).toContain('_final-release-assets.json');
  expect(publication.run).toContain('length !== 5');
  expect(publication.run).toContain('OPENOPC_COSIGN_FINAL_RELEASE_ASSET_INVALID');
  expect(publication.run).toContain('releaseAssetId');
  expect(publication.run).toContain('asset.digest');
  expect(publication.run).toContain('cosign-linux-amd64.asset.json');
  expect(publication.run).toContain('windows-amd64.jsonl.asset.json');
  expect(publication.run).toContain('manifest.asset.json');
});
