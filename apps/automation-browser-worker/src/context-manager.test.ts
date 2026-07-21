import { describe, expect, test } from 'bun:test';
import { type BrowserAdapter, createBrowserContextManager } from './context-manager';

const PROJECT_ID = '10000000-0000-4000-a000-000000000001';

function browser(options?: { pageCloseFails?: boolean; pageCloseGate?: Promise<void> }): {
  browser: BrowserAdapter;
  closed: string[];
} {
  const closed: string[] = [];
  const page = {
    close: async () => {
      closed.push('page');
      await options?.pageCloseGate;
      if (options?.pageCloseFails) throw new Error('page close failed');
    },
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      closed.push('context');
    },
  };
  return {
    closed,
    browser: {
      newContext: async () => context,
      close: async () => {
        closed.push('browser');
      },
    },
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

  test('accepts only a same-project encrypted profile reference and one-time broker credential', async () => {
    const fake = browser();
    const manager = createBrowserContextManager({
      browser: fake.browser,
      profileBroker: { fetchEncryptedProfile: async () => ({ storageState: { cookies: [] } }) },
    });
    await manager.openPersistent(
      {
        projectId: PROJECT_ID,
        profileId: '40000000-0000-4000-a000-000000000001',
        encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
        brokerCredential: 'one-time-token',
      },
      {
        projectId: PROJECT_ID,
        profileId: '40000000-0000-4000-a000-000000000001',
      },
      new AbortController().signal,
    );
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
          encryptedObjectRef: 'C:\\Users\\profile',
          brokerCredential: 'second-token',
        },
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('encrypted');
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
          encryptedObjectRef:
            'projects/20000000-0000-4000-a000-000000000001/browser-profiles/profile.enc',
          brokerCredential: 'third-token',
        },
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('project');
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
          encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
          brokerCredential: 'one-time-token',
        },
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('reused');
  });

  test('binds the persistent grant to the authoritative lease project and policy profile', async () => {
    const fake = browser();
    const manager = createBrowserContextManager({
      browser: fake.browser,
      profileBroker: { fetchEncryptedProfile: async () => ({ storageState: { cookies: [] } }) },
    });

    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          profileId: '40000000-0000-4000-a000-000000000001',
          encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
          brokerCredential: 'one-time-token',
        },
        {
          projectId: '20000000-0000-4000-a000-000000000001',
          profileId: '40000000-0000-4000-a000-000000000001',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('project');
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
