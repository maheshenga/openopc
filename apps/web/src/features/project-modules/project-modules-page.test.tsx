import { describe, expect, test } from 'bun:test';
import type { ProjectModuleInstallation, ProjectModuleInstallationEvent } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProjectModulesView,
  type PublishedProjectModuleRelease,
  projectModuleRollbackTargets,
} from './project-modules-page';

const PROJECT_ID = '50000000-0000-4000-a000-000000000000';

const INSTALLATION: ProjectModuleInstallation = {
  installation_id: '51000000-0000-4000-a000-000000000001',
  project_id: 'project-1',
  account_id: '52000000-0000-4000-a000-000000000002',
  module_id: 'openopc.recruiting',
  active_release_id: 'release-v2',
  active_version: '2.0.0',
  install_revision: 2,
  status: 'active',
  installed_by: '53000000-0000-4000-a000-000000000003',
  created_at: '2026-07-24T08:00:00.000Z',
  updated_at: '2026-07-24T09:00:00.000Z',
};

const RELEASES: PublishedProjectModuleRelease[] = [
  {
    release_id: 'release-v1',
    module_id: INSTALLATION.module_id,
    module_version: '1.0.0',
    item_name: 'Recruiting workflow',
    publisher_id: 'openopc',
    signature_key_id: 'openopc-2026',
    signed_at: '2026-07-24T07:00:00.000Z',
    published_at: '2026-07-24T07:05:00.000Z',
  },
  {
    release_id: 'release-v2',
    module_id: INSTALLATION.module_id,
    module_version: '2.0.0',
    item_name: 'Recruiting workflow',
    publisher_id: 'openopc',
    signature_key_id: 'openopc-2026',
    signed_at: '2026-07-24T08:00:00.000Z',
    published_at: '2026-07-24T08:05:00.000Z',
  },
  {
    release_id: 'release-v3',
    module_id: INSTALLATION.module_id,
    module_version: '3.0.0',
    item_name: 'Recruiting workflow',
    publisher_id: 'openopc',
    signature_key_id: 'openopc-2026',
    signed_at: '2026-07-24T10:00:00.000Z',
    published_at: '2026-07-24T10:05:00.000Z',
  },
];

const HISTORY: ProjectModuleInstallationEvent[] = [
  {
    installation_event_id: '54000000-0000-4000-a000-000000000001',
    installation_id: INSTALLATION.installation_id,
    project_id: INSTALLATION.project_id,
    account_id: INSTALLATION.account_id,
    sequence: 1,
    action: 'install',
    from_release_id: null,
    to_release_id: 'release-v1',
    expected_revision: 0,
    resulting_revision: 1,
    idempotency_key: null,
    actor_user_id: INSTALLATION.installed_by,
    created_at: INSTALLATION.created_at,
  },
  {
    installation_event_id: '54000000-0000-4000-a000-000000000002',
    installation_id: INSTALLATION.installation_id,
    project_id: INSTALLATION.project_id,
    account_id: INSTALLATION.account_id,
    sequence: 2,
    action: 'update',
    from_release_id: 'release-v1',
    to_release_id: 'release-v2',
    expected_revision: 1,
    resulting_revision: 2,
    idempotency_key: null,
    actor_user_id: INSTALLATION.installed_by,
    created_at: INSTALLATION.updated_at,
  },
];

const noop = () => undefined;

function renderView(overrides: Partial<Parameters<typeof ProjectModulesView>[0]> = {}): string {
  return renderToStaticMarkup(
    <ProjectModulesView
      projectId={PROJECT_ID}
      state="ready"
      modules={[INSTALLATION]}
      releases={RELEASES}
      historyByInstallation={{ [INSTALLATION.installation_id]: HISTORY }}
      canWrite
      pendingModuleId={null}
      errorCode={null}
      onInstall={noop}
      onUpdate={noop}
      onRollback={noop}
      onReload={noop}
      {...overrides}
    />,
  );
}

describe('Project modules workbench', () => {
  test('renders Open module only for active sandboxed Web releases with a signed manifest', () => {
    const sandboxedRelease: PublishedProjectModuleRelease = {
      ...RELEASES[1],
      manifest: {
        schemaVersion: 3,
        execution: {
          mode: 'sandboxed-web',
          entry: 'web/index.html',
        },
      },
    };

    const html = renderView({ releases: [RELEASES[0], sandboxedRelease, RELEASES[2]] });
    expect(html).toContain(`/projects/${PROJECT_ID}/modules/${INSTALLATION.installation_id}`);
    expect(html).toContain('Open module');

    expect(
      renderView({
        releases: [
          RELEASES[0],
          {
            ...sandboxedRelease,
            manifest: {
              schemaVersion: 3,
              execution: { mode: 'declarative' },
            },
          },
          RELEASES[2],
        ],
      }),
    ).not.toContain('Open module');
    expect(
      renderView({
        modules: [{ ...INSTALLATION, status: 'blocked' }],
        releases: [RELEASES[0], sandboxedRelease, RELEASES[2]],
      }),
    ).not.toContain('Open module');
    expect(renderView()).not.toContain('Open module');
  });

  test('renders loading, empty, and recoverable error states', () => {
    expect(renderView({ state: 'loading', modules: [], releases: [] })).toContain(
      'Loading installed modules',
    );
    expect(renderView({ state: 'empty', modules: [], releases: [] })).toContain(
      'No modules installed',
    );
    const error = renderView({
      state: 'error',
      modules: [],
      releases: [],
      errorCode: 'PROJECT_MODULE_INSTALL_CONFLICT',
    });
    expect(error).toContain('changed in another session');
    expect(error).toContain('Reload');
    expect(error).not.toContain('Retry mutation');
  });

  test('renders compact installed state, exact update target, signature, and history', () => {
    const html = renderView();

    expect(html).toContain('Installed modules');
    expect(html).toContain('Recruiting workflow');
    expect(html).toContain('2.0.0');
    expect(html).toContain('3.0.0');
    expect(html).toContain('openopc-2026');
    expect(html).toContain('Installation history');
    expect(html).toContain('1.0.0');
  });

  test('limits rollback choices to exact releases present in installation history', () => {
    expect(
      projectModuleRollbackTargets(INSTALLATION, RELEASES, HISTORY).map((item) => item.release_id),
    ).toEqual(['release-v1']);
  });

  test('hides all mutation controls without project customize-write capability', () => {
    const html = renderView({ canWrite: false });

    expect(html).toContain('Read-only');
    expect(html).not.toContain('data-testid="install-module"');
    expect(html).not.toContain('data-testid="update-module"');
    expect(html).not.toContain('data-testid="rollback-module"');
  });

  test('surfaces revoked active releases as blocked with no mutation controls', () => {
    const html = renderView({ modules: [{ ...INSTALLATION, status: 'blocked' }] });

    expect(html).toContain('Blocked');
    expect(html).toContain('The active release was revoked');
    expect(html).not.toContain('data-testid="update-module"');
    expect(html).not.toContain('data-testid="rollback-module"');
  });

  test('does not render service consent controls when the release has no openopc services', () => {
    const html = renderView();

    expect(html).not.toContain('Service access');
    expect(html).not.toContain('Grant service access');
  });

  test('renders only the exact declared AI and payment operations', () => {
    const html = renderView({
      releases: RELEASES.map((release) =>
        release.release_id === 'release-v2'
          ? {
              ...release,
              manifest: {
                schemaVersion: 3,
                openopc: {
                  sdkApiVersion: 'v1',
                  services: {
                    ai: { operations: ['models.read', 'text.generate'] },
                    payment: { operations: ['orders.create'] },
                  },
                },
              },
            }
          : release,
      ),
    });

    expect(html).toContain('AI service');
    expect(html).toContain('models.read');
    expect(html).toContain('text.generate');
    expect(html).toContain('Payment service');
    expect(html).toContain('orders.create');
    expect(html).not.toContain('refunds.create');
  });
});
