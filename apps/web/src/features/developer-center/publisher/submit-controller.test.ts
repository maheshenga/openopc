import { describe, expect, mock, test } from 'bun:test';
import type { DeveloperModuleRelease, DeveloperModuleReleaseSubmission } from '@kortix/sdk';

import { DEVELOPER_MODULE_INPUT_MAX_BYTES } from '../model';
import {
  createArtifactBackedDeveloperModuleSubmit,
  createDeveloperModuleSubmitController,
} from './submit-controller';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const VALID_ITEM = { type: 'registry:module', id: 'acme.recruiting', version: '1.0.0' };
const VALID_JSON = JSON.stringify(VALID_ITEM);

const SUBMITTED_RELEASE: DeveloperModuleRelease = {
  release_id: '12000000-0000-4000-a000-000000000001',
  account_id: ACCOUNT_ID,
  item_name: 'Recruiting',
  publisher_id: 'acme',
  module_id: 'acme.recruiting',
  module_version: '1.0.0',
  manifest: VALID_ITEM,
  manifest_digest: `sha256:${'a'.repeat(64)}`,
  artifact_id: '14000000-0000-4000-a000-000000000001',
  artifact_digest: `sha256:${'b'.repeat(64)}`,
  sbom_digest: null,
  trust_attestation_digest: null,
  verification_policy_digest: `sha256:${'c'.repeat(64)}`,
  runtime_descriptor_digest: null,
  runtime_descriptor_path: null,
  runtime_kind: null,
  review_requirements: ['manifest_review', 'human_review'],
  status: 'validated',
  review_revision: 0,
  signature_algorithm: null,
  signature_key_id: null,
  signature: null,
  signature_payload_digest: null,
  signed_at: null,
  published_at: null,
  revoked_at: null,
  created_by: '13000000-0000-4000-a000-000000000001',
  created_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
};

function submission(): DeveloperModuleReleaseSubmission {
  return {
    created: true,
    release: SUBMITTED_RELEASE,
  };
}

describe('Developer module submit controller', () => {
  test('creates a canonical artifact before submitting an artifact-only release', async () => {
    const createArtifact = mock(async () => ({ artifact_id: 'artifact-1' }));
    const submitRelease = mock(async () => submission());
    const submit = createArtifactBackedDeveloperModuleSubmit({ createArtifact, submitRelease });

    await submit(VALID_ITEM, ACCOUNT_ID);

    expect(createArtifact).toHaveBeenCalledWith(VALID_ITEM, { accountId: ACCOUNT_ID });
    expect(submitRelease).toHaveBeenCalledWith({
      artifactId: 'artifact-1',
      accountId: ACCOUNT_ID,
    });
    expect(JSON.stringify(submitRelease.mock.calls)).not.toContain('registry:module');
  });

  test('makes zero SDK calls for malformed or over-limit input', async () => {
    const validate = mock(async () => ({ valid: true, issues: [] }));
    const submit = mock(async () => submission());
    const controller = createDeveloperModuleSubmitController({ validate, submit });

    controller.setText('{');
    await controller.validate();
    controller.setText('x'.repeat(DEVELOPER_MODULE_INPUT_MAX_BYTES + 1));
    await controller.validate();

    expect(validate).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test('keeps validation issues in input stage with typed paths and messages', async () => {
    const validate = mock(async () => ({
      valid: false,
      issues: [{ severity: 'error' as const, path: 'permissions', message: 'Required' }],
    }));
    const controller = createDeveloperModuleSubmitController({
      validate,
      submit: async () => submission(),
    });

    controller.setText(VALID_JSON);
    const state = await controller.validate();

    expect(state.stage).toBe('input');
    expect(state.issues).toEqual([{ severity: 'error', path: 'permissions', message: 'Required' }]);
    expect(state.parsedItem).toBeNull();
  });

  test('moves to confirmation without persistence after successful validation', async () => {
    const submit = mock(async () => submission());
    const controller = createDeveloperModuleSubmitController({
      validate: async () => ({ valid: true, issues: [] }),
      submit,
    });

    controller.setText(VALID_JSON);
    const state = await controller.validate();

    expect(state.stage).toBe('confirm');
    expect(state.parsedItem).toEqual(VALID_ITEM);
    expect(submit).not.toHaveBeenCalled();
  });

  test('submits exactly the validated object and account once', async () => {
    const submit = mock(async () => submission());
    const controller = createDeveloperModuleSubmitController({
      validate: async () => ({ valid: true, issues: [] }),
      submit,
    });

    controller.setText(VALID_JSON);
    await controller.validate();
    await controller.confirm(ACCOUNT_ID);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(VALID_ITEM, ACCOUNT_ID);
  });

  test('editing text clears the confirmation snapshot', async () => {
    const controller = createDeveloperModuleSubmitController({
      validate: async () => ({ valid: true, issues: [] }),
      submit: async () => submission(),
    });

    controller.setText(VALID_JSON);
    await controller.validate();
    controller.setText(JSON.stringify({ ...VALID_ITEM, version: '1.0.1' }));

    expect(controller.getState()).toMatchObject({ stage: 'input', parsedItem: null, issues: [] });
  });

  test('concurrent confirmations share one pending promise', async () => {
    let resolveSubmit!: (value: ReturnType<typeof submission>) => void;
    const submit = mock(
      () =>
        new Promise<ReturnType<typeof submission>>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const controller = createDeveloperModuleSubmitController({
      validate: async () => ({ valid: true, issues: [] }),
      submit,
    });

    controller.setText(VALID_JSON);
    await controller.validate();
    const first = controller.confirm(ACCOUNT_ID);
    const replay = controller.confirm(ACCOUNT_ID);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(first).toBe(replay);
    resolveSubmit(submission());
    expect(await first).toEqual(await replay);
  });
});
