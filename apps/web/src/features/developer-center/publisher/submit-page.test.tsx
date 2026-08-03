import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SelectableDeveloperPublisher } from './access';
import { DeveloperModuleSubmitView } from './submit-page';

const ITEM = {
  type: 'registry:module',
  publisher_id: 'acme',
  id: 'acme.recruiting',
  version: '1.0.0',
  execution_mode: 'sandbox',
  permissions: { network: ['https://api.example.test'] },
  review_requirements: ['manifest_review', 'human_review'],
};

const noop = () => undefined;

function publisherOption(publisherId: string, displayName: string): SelectableDeveloperPublisher {
  return {
    publisher: {
      publisher_id: publisherId,
      account_id: 'account-1',
      organization_id: 'organization-1',
      slug: publisherId,
      display_name: displayName,
      status: 'active',
      authority_revision: 0,
      suspended_reason: null,
      suspended_by: null,
      suspended_at: null,
      created_by: 'user-1',
      created_at: '2026-08-03T08:00:00.000Z',
      updated_at: '2026-08-03T08:00:00.000Z',
    },
    membership: {
      member_id: `${publisherId}-member`,
      account_id: 'account-1',
      publisher_id: publisherId,
      user_id: 'user-1',
      role: 'owner',
      revision: 0,
      created_by: 'user-1',
      created_at: '2026-08-03T08:00:00.000Z',
      updated_by: null,
      updated_at: '2026-08-03T08:00:00.000Z',
    },
  };
}

const PUBLISHER_A = publisherOption('acme', 'Acme Studio');
const PUBLISHER_B = publisherOption('second', 'Second Studio');

describe('Developer module submit view', () => {
  test('renders input, validation issues, and an upload control', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        stage="input"
        text={'{"type":"registry:module"}'}
        item={null}
        issues={[{ severity: 'error', path: 'id', message: 'Required' }]}
        inputErrorCode={null}
        canWrite
        pending={false}
        errorCode={null}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
      />,
    );

    expect(html).toContain('Upload JSON');
    expect(html).toContain('Required');
    expect(html).toContain('id');
    expect(html).toContain('Validate');
    expect(html).toContain('Declarative JSON');
    expect(html).toContain('Package upload');
  });

  test('renders the package Publisher selector instead of a free-form Publisher ID', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        mode="package"
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        packageFileName="module.openopc"
        packagePublisherId="acme"
        packagePublishers={[PUBLISHER_A, PUBLISHER_B]}
        packageState={{
          stage: 'idle',
          fileName: null,
          fileSize: 0,
          progress: 0,
          digest: null,
          uploadId: null,
          artifact: null,
          submission: null,
        }}
        errorCode={null}
        onModeChange={noop}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
        onPackagePublisherIdChange={noop}
        onPackageFile={noop}
        onStartPackage={noop}
        onCancelPackage={noop}
      />,
    );

    expect(html).toContain('Publisher');
    expect(html).toContain('Acme Studio');
    expect(html).not.toContain('placeholder="acme"');
    expect(html).not.toContain('Publisher ID');
  });

  test('shows the application path and disables package upload without an active owner Publisher', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        mode="package"
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        packageFileName="module.openopc"
        packagePublisherId=""
        packagePublishers={[]}
        packageState={{
          stage: 'idle',
          fileName: null,
          fileSize: 0,
          progress: 0,
          digest: null,
          uploadId: null,
          artifact: null,
          submission: null,
        }}
        errorCode={null}
        onModeChange={noop}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
        onPackagePublisherIdChange={noop}
        onPackageFile={noop}
        onStartPackage={noop}
        onCancelPackage={noop}
      />,
    );

    expect(html).toContain('href="/developer/apply"');
    expect(html).not.toContain('developer-module-publisher');
    expect(html).not.toContain('Publisher ID');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Upload package<\/button>/);
  });

  test('shows a bounded Publisher access error with retry before confirmed-empty', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        mode="package"
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        packageFileName="module.openopc"
        packagePublisherId=""
        packagePublishers={[]}
        packageAccessError
        packageState={{
          stage: 'idle',
          fileName: null,
          fileSize: 0,
          progress: 0,
          digest: null,
          uploadId: null,
          artifact: null,
          submission: null,
        }}
        errorCode={null}
        onModeChange={noop}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
        onPackagePublisherIdChange={noop}
        onPackageFile={noop}
        onStartPackage={noop}
        onCancelPackage={noop}
        onRetryPackageAccess={noop}
      />,
    );

    expect(html).toContain('Publisher access unavailable');
    expect(html).toContain('Retry');
    expect(html).toContain('min-h-10');
    expect(html).not.toContain('href="/developer/apply"');
    expect(html).not.toContain('developer-module-publisher');
    expect(html).not.toContain('Publisher ID');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Upload package<\/button>/);
  });

  test('disables the Publisher selector while an active package upload keeps cancel available', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        mode="package"
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        packageFileName="module.openopc"
        packagePublisherId="acme"
        packagePublishers={[PUBLISHER_A, PUBLISHER_B]}
        packageState={{
          stage: 'uploading',
          fileName: 'module.openopc',
          fileSize: 4096,
          progress: 67,
          digest: `sha256:${'a'.repeat(64)}`,
          uploadId: 'upload-1',
          artifact: null,
          submission: null,
        }}
        errorCode={null}
        onModeChange={noop}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
        onPackagePublisherIdChange={noop}
        onPackageFile={noop}
        onStartPackage={noop}
        onCancelPackage={noop}
      />,
    );

    expect(html).toContain('67%');
    expect(html).toContain('Uploading package');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*id="developer-module-publisher"/);
    expect(html).toContain('Cancel upload');
  });

  test('shows only the server-authoritative artifact digest after finalization', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        mode="package"
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        packageFileName="module.openopc"
        packagePublisherId="acme"
        packageState={{
          stage: 'submitting',
          fileName: 'module.openopc',
          fileSize: 4096,
          progress: 90,
          digest,
          uploadId: 'upload-1',
          artifact: {
            artifact_id: 'artifact-1',
            account_id: 'account-1',
            publisher_id: 'acme',
            artifact_digest: digest,
            envelope_digest: `sha256:${'b'.repeat(64)}`,
            media_type: 'application/vnd.openopc.developer-module.v2+json',
            size_bytes: 4096,
            item_snapshot: { type: 'registry:module' },
            source_provenance: null,
            created_by: 'user-1',
            created_at: '2026-07-25T12:00:00.000Z',
          },
          submission: null,
        }}
        errorCode={null}
        onModeChange={noop}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
        onPackagePublisherIdChange={noop}
        onPackageFile={noop}
        onStartPackage={noop}
        onCancelPackage={noop}
      />,
    );

    expect(html).toContain('Server artifact digest');
    expect(html).toContain(digest);
    expect(html).not.toContain('upload_url');
    expect(html).not.toContain('x-upload-token');
  });

  test('renders a confirmation summary and does not put manifest input in a URL or hidden field', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        stage="confirm"
        text={JSON.stringify(ITEM)}
        item={ITEM}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        errorCode={null}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
      />,
    );

    expect(html).toContain('Confirm submission');
    expect(html).toContain('acme.recruiting');
    expect(html).toContain('sandbox');
    expect(html).toContain('Submit release');
    expect(html).not.toContain('<input type="hidden"');
    expect(html).not.toContain(`href="${JSON.stringify(ITEM)}"`);
  });

  test('keeps confirmation read-only without account.write and disables pending submission', () => {
    const readOnly = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        stage="confirm"
        text={JSON.stringify(ITEM)}
        item={ITEM}
        issues={[]}
        inputErrorCode={null}
        canWrite={false}
        pending={false}
        errorCode={null}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
      />,
    );
    const pending = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        stage="confirm"
        text={JSON.stringify(ITEM)}
        item={ITEM}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending
        errorCode={null}
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
      />,
    );

    expect(readOnly).toContain('Account write permission is required');
    expect(readOnly).not.toContain('Submit release');
    expect(pending).toContain('Submitting...');
    expect(pending).toContain('disabled=""');
  });

  test('renders stable API errors without echoing rejected input', () => {
    const html = renderToStaticMarkup(
      <DeveloperModuleSubmitView
        stage="input"
        text=""
        item={null}
        issues={[]}
        inputErrorCode={null}
        canWrite
        pending={false}
        errorCode="DEVELOPER_MODULE_INVALID"
        onTextChange={noop}
        onValidate={noop}
        onConfirm={noop}
      />,
    );

    expect(html).toContain('DEVELOPER_MODULE_INVALID');
    expect(html).not.toContain('Bearer');
  });
});
