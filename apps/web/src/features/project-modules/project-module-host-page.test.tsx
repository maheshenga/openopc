import { describe, expect, test } from 'bun:test';
import type { ProjectModuleLaunchDescriptor } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PublishedProjectModuleRelease } from './client';
import { ProjectModuleHostView, type ProjectModuleHostViewProps } from './project-module-host-page';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '30000000-0000-4000-8000-000000000003';

const DESCRIPTOR: ProjectModuleLaunchDescriptor = {
  installation_id: INSTALLATION_ID,
  release_id: RELEASE_ID,
  install_revision: 7,
  module_id: 'openopc.recruiting',
  module_version: '2.0.0',
  execution_mode: 'sandboxed-web',
  url: `https://modules.openopc.example/releases/${RELEASE_ID}/index.html`,
  origin: 'https://modules.openopc.example',
};

const RELEASE: PublishedProjectModuleRelease = {
  release_id: RELEASE_ID,
  module_id: DESCRIPTOR.module_id,
  module_version: DESCRIPTOR.module_version,
  item_name: 'Recruiting workflow',
  publisher_id: 'openopc',
  signature_key_id: 'openopc-2026',
  signed_at: '2026-08-01T00:00:00.000Z',
  published_at: '2026-08-01T00:01:00.000Z',
  manifest: {
    schemaVersion: 3,
    id: DESCRIPTOR.module_id,
    version: DESCRIPTOR.module_version,
    execution: { mode: 'sandboxed-web', entry: 'web/index.html' },
  },
};

const noop = () => undefined;

function renderView(overrides: Partial<ProjectModuleHostViewProps> = {}): string {
  return renderToStaticMarkup(
    <ProjectModuleHostView
      state="ready"
      projectId={PROJECT_ID}
      descriptor={DESCRIPTOR}
      release={RELEASE}
      errorCode={null}
      onReload={noop}
      {...overrides}
    />,
  );
}

describe('project module host view', () => {
  test('renders the active loading state with the shared Loading primitive', () => {
    const html = renderView({ state: 'loading', descriptor: null, release: null });

    expect(html).toContain('Loading module');
    expect(html).toContain('spinner-rotate');
  });

  test('renders exact module identity and a tightly sandboxed iframe', () => {
    const html = renderView();

    expect(html).toContain(RELEASE.item_name);
    expect(html).toContain(DESCRIPTOR.module_id);
    expect(html).toContain(DESCRIPTOR.module_version);
    expect(html).toContain(`src="${DESCRIPTOR.url}"`);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-same-origin"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('title="Recruiting workflow module"');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).not.toContain('allow-popups');
    expect(html).not.toContain('allow-downloads');
  });

  test('renders a project modules back link and visible reload action', () => {
    const html = renderView();

    expect(html).toContain(`href="/projects/${PROJECT_ID}/modules"`);
    expect(html).toContain('Reload module');
  });

  test('renders unavailable copy for every bounded launch code', () => {
    const cases = [
      ['PROJECT_MODULE_INACTIVE', 'This module is no longer active.'],
      ['PROJECT_MODULE_NOT_LAUNCHABLE', 'This module does not provide a sandboxed Web experience.'],
      [
        'PROJECT_MODULE_LAUNCH_STALE',
        'This module changed while it was opening. Reload to use the current release.',
      ],
      ['PROJECT_MODULE_HOST_UNAVAILABLE', 'The module host is unavailable. Try again shortly.'],
      [
        'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
        'This module cannot run with the current platform capability profile.',
      ],
    ] as const;

    for (const [errorCode, copy] of cases) {
      const html = renderView({ state: 'error', descriptor: null, release: null, errorCode });

      expect(html).toContain('Module unavailable');
      expect(html).toContain(copy);
      expect(html).not.toContain('<iframe');
    }
  });
});
