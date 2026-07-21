import { describe, expect, test } from 'bun:test';
import { type BrowserAdapter, createBrowserContextManager } from './context-manager';

const PROJECT_ID = '10000000-0000-4000-a000-000000000001';

function browser(): { browser: BrowserAdapter; closed: string[] } {
  const closed: string[] = [];
  const page = {
    close: async () => {
      closed.push('page');
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
        encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
        brokerCredential: 'one-time-token',
      },
      new AbortController().signal,
    );
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          encryptedObjectRef: 'C:\\Users\\profile',
          brokerCredential: 'second-token',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('encrypted');
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          encryptedObjectRef:
            'projects/20000000-0000-4000-a000-000000000001/browser-profiles/profile.enc',
          brokerCredential: 'third-token',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('project');
    await expect(
      manager.openPersistent(
        {
          projectId: PROJECT_ID,
          encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
          brokerCredential: 'one-time-token',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('reused');
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
});
