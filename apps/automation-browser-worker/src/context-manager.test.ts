import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type BrokeredPersistentProfile,
  type BrowserAdapter,
  type BrowserProfileBroker,
  type PersistentProfileAuthority,
  type PersistentProfileRequest,
  createBrowserContextManager,
} from './context-manager';

const PROJECT_ID = '10000000-0000-4000-a000-000000000001';
const PROFILE_ID = '40000000-0000-4000-a000-000000000001';
const JOB_ID = '50000000-0000-4000-a000-000000000001';
const LEASE_ID = '60000000-0000-4000-a000-000000000001';
const OTHER_ID = '90000000-0000-4000-a000-000000000001';
const AUTHORITY = {
  projectId: PROJECT_ID,
  profileId: PROFILE_ID,
  jobId: JOB_ID,
  leaseId: LEASE_ID,
  killSwitchGeneration: 7,
} as const satisfies PersistentProfileAuthority;
const STORAGE_STATE = { cookies: [], origins: [] };

function stateHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const PROFILE = {
  ...AUTHORITY,
  status: 'active' as const,
  expiresAt: '2999-01-01T00:00:00.000Z',
  revokedAt: null,
  sealedStateRef: `sealed:projects/${PROJECT_ID}/browser-profiles/${PROFILE_ID}.enc`,
  stateHash: stateHash(STORAGE_STATE),
  storageState: STORAGE_STATE,
} satisfies BrokeredPersistentProfile;

function browser(options?: { pageCloseFails?: boolean; pageCloseGate?: Promise<void> }): {
  browser: BrowserAdapter;
  closed: string[];
  contextOptions: unknown[];
} {
  const closed: string[] = [];
  const contextOptions: unknown[] = [];
  const page = {
    close: async () => {
      closed.push('page');
      await options?.pageCloseGate;
      if (options?.pageCloseFails) throw new Error('page close failed');
    },
  };
  const context = {
    newPage: async () => page,
    route: async () => undefined,
    close: async () => {
      closed.push('context');
    },
  };
  return {
    closed,
    contextOptions,
    browser: {
      newContext: async (input) => {
        contextOptions.push(input);
        return context;
      },
      close: async () => {
        closed.push('browser');
      },
    },
  };
}

function atomicProfileBroker(): BrowserProfileBroker {
  let consumed = false;
  return {
    consumePersistentProfile: async (input) => {
      if (
        consumed ||
        input.brokerCredential !== 'one-time-token' ||
        input.projectId !== AUTHORITY.projectId ||
        input.profileId !== AUTHORITY.profileId ||
        input.jobId !== AUTHORITY.jobId ||
        input.leaseId !== AUTHORITY.leaseId ||
        input.killSwitchGeneration !== AUTHORITY.killSwitchGeneration
      ) {
        return null;
      }
      consumed = true;
      return structuredClone(PROFILE);
    },
  };
}

function returningProfileBroker(profile: BrokeredPersistentProfile): BrowserProfileBroker {
  return {
    consumePersistentProfile: async () => structuredClone(profile),
  };
}

describe('browser context manager', () => {
  test('closes every temporary page and context when a request ends', async () => {
    const fake = browser();
    const session = await createBrowserContextManager({ browser: fake.browser }).openTemporary(
      new AbortController().signal,
    );
    await session.close();
    expect(fake.closed).toEqual(['page', 'context']);
  });

  test('closes a newly allocated context when route preparation fails', async () => {
    const fake = browser();
    const manager = createBrowserContextManager({
      browser: fake.browser,
      prepareContext: async () => {
        throw new Error('route preparation failed');
      },
    });

    await expect(manager.openTemporary(new AbortController().signal)).rejects.toThrow(
      'route preparation failed',
    );
    expect(fake.closed).toEqual(['context']);
  });

  test('resolves persistent state from a one-time credential without an object reference in the request', async () => {
    const fake = browser();
    const manager = createBrowserContextManager({
      browser: fake.browser,
      profileBroker: atomicProfileBroker(),
    });
    const session = await manager.openPersistent(
      { brokerCredential: 'one-time-token' },
      AUTHORITY,
      new AbortController().signal,
    );

    expect(fake.contextOptions).toEqual([
      {
        acceptDownloads: false,
        serviceWorkers: 'block',
        storageState: STORAGE_STATE,
      },
    ]);
    await session.close();
  });

  test('rejects one-time credential replay across separate context managers', async () => {
    const broker = atomicProfileBroker();
    const firstBrowser = browser();
    const secondBrowser = browser();
    const first = createBrowserContextManager({
      browser: firstBrowser.browser,
      profileBroker: broker,
    });
    const second = createBrowserContextManager({
      browser: secondBrowser.browser,
      profileBroker: broker,
    });
    const request: PersistentProfileRequest = { brokerCredential: 'one-time-token' };

    const session = await first.openPersistent(request, AUTHORITY, new AbortController().signal);
    await session.close();

    await expect(
      second.openPersistent(request, AUTHORITY, new AbortController().signal),
    ).rejects.toThrow('credential');
    expect(secondBrowser.contextOptions).toHaveLength(0);
  });

  test('binds credential consumption to project, profile, job, lease, and kill generation', async () => {
    for (const authority of [
      { ...AUTHORITY, projectId: OTHER_ID },
      { ...AUTHORITY, profileId: OTHER_ID },
      { ...AUTHORITY, jobId: OTHER_ID },
      { ...AUTHORITY, leaseId: OTHER_ID },
      { ...AUTHORITY, killSwitchGeneration: 8 },
    ]) {
      const fake = browser();
      const manager = createBrowserContextManager({
        browser: fake.browser,
        profileBroker: atomicProfileBroker(),
      });
      await expect(
        manager.openPersistent(
          { brokerCredential: 'one-time-token' },
          authority,
          new AbortController().signal,
        ),
      ).rejects.toThrow('credential');
      expect(fake.contextOptions).toHaveLength(0);
    }
  });

  test('rejects a broker response outside the authoritative execution binding', async () => {
    for (const profile of [
      { ...PROFILE, projectId: OTHER_ID },
      { ...PROFILE, profileId: OTHER_ID },
      { ...PROFILE, jobId: OTHER_ID },
      { ...PROFILE, leaseId: OTHER_ID },
      { ...PROFILE, killSwitchGeneration: 8 },
    ]) {
      const fake = browser();
      const manager = createBrowserContextManager({
        browser: fake.browser,
        profileBroker: returningProfileBroker(profile as BrokeredPersistentProfile),
      });
      await expect(
        manager.openPersistent(
          { brokerCredential: 'one-time-token' },
          AUTHORITY,
          new AbortController().signal,
        ),
      ).rejects.toThrow('binding');
      expect(fake.contextOptions).toHaveLength(0);
    }
  });

  test('rejects inactive, expired, or revoked broker profile results', async () => {
    for (const profile of [
      { ...PROFILE, status: 'revoked' as const },
      { ...PROFILE, expiresAt: '2000-01-01T00:00:00.000Z' },
      { ...PROFILE, revokedAt: '2026-07-22T00:00:00.000Z' },
    ]) {
      const fake = browser();
      const manager = createBrowserContextManager({
        browser: fake.browser,
        profileBroker: returningProfileBroker(profile as BrokeredPersistentProfile),
      });
      await expect(
        manager.openPersistent(
          { brokerCredential: 'one-time-token' },
          AUTHORITY,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/active|expired|revoked/);
      expect(fake.contextOptions).toHaveLength(0);
    }
  });

  test('rejects invalid sealed references and state hashes returned by the broker', async () => {
    for (const profile of [
      { ...PROFILE, sealedStateRef: `projects/${PROJECT_ID}/profile.enc` },
      { ...PROFILE, stateHash: `sha256:${'0'.repeat(64)}` as const },
    ]) {
      const fake = browser();
      const manager = createBrowserContextManager({
        browser: fake.browser,
        profileBroker: returningProfileBroker(profile as BrokeredPersistentProfile),
      });
      await expect(
        manager.openPersistent(
          { brokerCredential: 'one-time-token' },
          AUTHORITY,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/sealed|state hash/);
      expect(fake.contextOptions).toHaveLength(0);
    }
  });

  test('closes page, context, and browser immediately on abort or kill signal', async () => {
    const fake = browser();
    const controller = new AbortController();
    const session = await createBrowserContextManager({
      browser: fake.browser,
      closeBrowserOnAbort: true,
    }).openTemporary(controller.signal);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.closed).toEqual(['page', 'context', 'browser']);
    await session.close();
  });

  test('continues closing context and browser when page cleanup fails', async () => {
    const fake = browser({ pageCloseFails: true });
    const controller = new AbortController();
    await createBrowserContextManager({
      browser: fake.browser,
      closeBrowserOnAbort: true,
    }).openTemporary(controller.signal);

    controller.abort('kill-switch');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.closed).toEqual(['page', 'context', 'browser']);
  });

  test('session close waits for cleanup already started by an abort', async () => {
    let release: () => void = () => undefined;
    const pageCloseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = browser({ pageCloseGate });
    const controller = new AbortController();
    const session = await createBrowserContextManager({
      browser: fake.browser,
      closeBrowserOnAbort: true,
    }).openTemporary(controller.signal);
    controller.abort('kill-switch');
    let closeCompleted = false;
    const closing = session.close().then(() => {
      closeCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCompleted).toBeFalse();

    release();
    await closing;
    expect(closeCompleted).toBeTrue();
  });
});
