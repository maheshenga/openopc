export interface BrowserPage {
  close(): Promise<void>;
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  newContext(options?: { storageState?: unknown }): Promise<BrowserContext>;
  close(): Promise<void>;
}

export type PersistentProfileRequest = Readonly<{
  projectId: string;
  encryptedObjectRef: string;
  brokerCredential: string;
}>;

export interface BrowserProfileBroker {
  fetchEncryptedProfile(input: PersistentProfileRequest): Promise<{ storageState: unknown }>;
}

export type BrowserSession = Readonly<{
  page: BrowserPage;
  context: BrowserContext;
  close(): Promise<void>;
}>;

function assertPersistentProfile(input: PersistentProfileRequest): void {
  const expectedPrefix = `projects/${input.projectId}/browser-profiles/`;
  if (!input.encryptedObjectRef.endsWith('.enc'))
    throw new Error('profile reference must be encrypted');
  if (!input.encryptedObjectRef.startsWith(expectedPrefix))
    throw new Error('profile reference project mismatch');
  if (input.brokerCredential.trim().length === 0) throw new Error('broker credential is required');
}

export function createBrowserContextManager(options: {
  browser: BrowserAdapter;
  profileBroker?: BrowserProfileBroker;
  closeBrowserOnAbort?: boolean;
}) {
  const consumedCredentials = new Set<string>();
  const closeBrowserOnAbort = options.closeBrowserOnAbort ?? true;

  const sessionFor = async (
    context: BrowserContext,
    signal: AbortSignal,
  ): Promise<BrowserSession> => {
    const page = await context.newPage();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', onAbort);
      await page.close();
      await context.close();
    };
    const onAbort = () => {
      void close().then(async () => {
        if (closeBrowserOnAbort) await options.browser.close();
      });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return { page, context, close };
  };

  return {
    async openTemporary(signal: AbortSignal): Promise<BrowserSession> {
      return sessionFor(await options.browser.newContext(), signal);
    },
    async openPersistent(
      input: PersistentProfileRequest,
      signal: AbortSignal,
    ): Promise<BrowserSession> {
      assertPersistentProfile(input);
      if (consumedCredentials.has(input.brokerCredential))
        throw new Error('reused broker credential');
      consumedCredentials.add(input.brokerCredential);
      if (!options.profileBroker) throw new Error('persistent profile broker is unavailable');
      const profile = await options.profileBroker.fetchEncryptedProfile(input);
      return sessionFor(
        await options.browser.newContext({ storageState: profile.storageState }),
        signal,
      );
    },
  };
}
