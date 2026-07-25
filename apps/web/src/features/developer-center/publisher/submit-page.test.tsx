import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

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

  test('renders the package upload mode with publisher identity and bounded progress', () => {
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

    expect(html).toContain('module.openopc');
    expect(html).toContain('Publisher ID');
    expect(html).toContain('67%');
    expect(html).toContain('Uploading package');
    expect(html).toContain('Cancel upload');
    expect(html).not.toContain('Paste JSON');
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
