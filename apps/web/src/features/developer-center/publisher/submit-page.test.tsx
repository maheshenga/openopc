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
