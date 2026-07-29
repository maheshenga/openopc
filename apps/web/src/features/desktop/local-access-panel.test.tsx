import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createLocalAccessOperationGuard,
  createLocalGrantListLoader,
  LocalAccessPanel,
  type LocalAccessBridge,
  type LocalGrant,
} from './local-access-panel';

function grant(grantId: string, userId: string): LocalGrant {
  return {
    grantId,
    capability: 'filesystem',
    roots: [`C:/${userId}`],
    userId,
    deviceId: 'device-1',
    issuedAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-07-29T00:30:00.000Z',
    commandDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    approvedLocally: true,
    revokedAt: null,
  };
}

function bridge(listLocalGrants: LocalAccessBridge['listLocalGrants']): LocalAccessBridge {
  return {
    listLocalGrants,
    requestLocalGrant: async () => {
      throw new Error('not used');
    },
    revokeLocalGrant: async () => {
      throw new Error('not used');
    },
  };
}

test('renders a remote-only state when the desktop bridge is unavailable', () => {
  const html = renderToStaticMarkup(<LocalAccessPanel userId="user-1" bridge={null} />);

  expect(html).toContain('data-local-access-panel');
  expect(html).toContain('Remote-only');
  expect(html).toContain('Web access remains available');
});

test('renders visible desktop grant state and a revoke action', () => {
  const html = renderToStaticMarkup(
    <LocalAccessPanel
      userId="user-1"
      bridge={{
        requestLocalGrant: async () => {
          throw new Error('not used');
        },
        listLocalGrants: async () => [],
        revokeLocalGrant: async () => {
          throw new Error('not used');
        },
      }}
      initialGrants={[
        {
          grantId: 'grant-1',
          capability: 'filesystem',
          roots: ['C:/workspace'],
          userId: 'user-1',
          deviceId: 'device-1',
          issuedAt: '2026-07-29T00:00:00.000Z',
          expiresAt: '2026-07-29T00:30:00.000Z',
          commandDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          approvedLocally: true,
          revokedAt: null,
        },
      ]}
    />,
  );

  expect(html).toContain('data-local-access-mode="desktop"');
  expect(html).toContain('Filesystem');
  expect(html).toContain('C:/workspace');
  expect(html).toContain('Revoke local grant');
});

test('does not present an expired grant as active', () => {
  const html = renderToStaticMarkup(
    <LocalAccessPanel
      userId="user-1"
      bridge={{
        requestLocalGrant: async () => {
          throw new Error('not used');
        },
        listLocalGrants: async () => [],
        revokeLocalGrant: async () => {
          throw new Error('not used');
        },
      }}
      initialGrants={[
        {
          grantId: 'grant-expired',
          capability: 'filesystem',
          roots: ['C:/workspace'],
          userId: 'user-1',
          deviceId: 'device-1',
          issuedAt: '2025-07-29T00:00:00.000Z',
          expiresAt: '2025-07-29T00:30:00.000Z',
          commandDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          approvedLocally: true,
          revokedAt: null,
        },
      ]}
    />,
  );

  expect(html).toContain('Expired');
  expect(html).not.toContain('>Active<');
});

test('does not render an initial grant belonging to another user', () => {
  const html = renderToStaticMarkup(
    <LocalAccessPanel
      userId="user-1"
      bridge={{
        requestLocalGrant: async () => {
          throw new Error('not used');
        },
        listLocalGrants: async () => [],
        revokeLocalGrant: async () => {
          throw new Error('not used');
        },
      }}
      initialGrants={[
        {
          grantId: 'grant-other-user',
          capability: 'full_access',
          roots: ['C:/private'],
          userId: 'user-2',
          deviceId: 'device-1',
          issuedAt: '2026-07-29T00:00:00.000Z',
          expiresAt: '2026-07-29T00:30:00.000Z',
          commandDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          approvedLocally: true,
          revokedAt: null,
        },
      ]}
    />,
  );

  expect(html).not.toContain('C:/private');
  expect(html).toContain('No local grants');
});

test('ignores an old grant-list response after the authenticated user changes', async () => {
  let resolveFirst: ((grants: LocalGrant[]) => void) | undefined;
  const loader = createLocalGrantListLoader();
  const first = loader.load(
    bridge(
      () =>
        new Promise<LocalGrant[]>((resolve) => {
          resolveFirst = resolve;
        }),
    ),
    'user-1',
  );
  const second = loader.load(
    bridge(async () => [grant('grant-2', 'user-2')]),
    'user-2',
  );

  expect(await second).toEqual({ grants: [grant('grant-2', 'user-2')], error: null });
  resolveFirst?.([grant('grant-1', 'user-1')]);
  expect(await first).toBeNull();
});

test('invalidates a deferred local mutation after the user or bridge changes', async () => {
  const firstBridge = bridge(async () => []);
  const secondBridge = bridge(async () => []);
  const guard = createLocalAccessOperationGuard({ userId: 'user-1', bridge: firstBridge });
  const firstOperation = guard.capture();
  let releaseOperation: (() => void) | undefined;
  const deferredOperation = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  }).then(() => guard.isCurrent(firstOperation));

  guard.update({ userId: 'user-2', bridge: firstBridge });
  releaseOperation?.();

  expect(await deferredOperation).toBe(false);
  const secondOperation = guard.capture();
  guard.update({ userId: 'user-2', bridge: secondBridge });
  expect(guard.isCurrent(secondOperation)).toBe(false);
  const currentOperation = guard.capture();
  expect(guard.isCurrent(currentOperation)).toBe(true);
  guard.invalidate();
  expect(guard.isCurrent(currentOperation)).toBe(false);
});

test('drops malformed local-grant records instead of rendering unsafe bridge data', async () => {
  const malformed = { ...grant('grant-malformed', 'user-1'), roots: null } as unknown as LocalGrant;
  const loader = createLocalGrantListLoader();

  expect(
    await loader.load(
      bridge(async () => [malformed]),
      'user-1',
    ),
  ).toEqual({ grants: [], error: null });
  const html = renderToStaticMarkup(
    <LocalAccessPanel
      userId="user-1"
      bridge={bridge(async () => [])}
      initialGrants={[malformed]}
    />,
  );
  expect(html).toContain('No local grants');
});
