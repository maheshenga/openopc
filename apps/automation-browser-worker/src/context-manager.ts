import { createHash } from 'node:crypto';

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
  profileId: string;
  encryptedObjectRef: string;
  brokerCredential: string;
}>;

export type PersistentProfileAuthority = Readonly<{
  projectId: string;
  profileId: string;
}>;

export interface BrowserProfileBroker {
  fetchEncryptedProfile(input: PersistentProfileRequest): Promise<{ storageState: unknown }>;
}

export type BrowserSession = Readonly<{
  page: BrowserPage;
  context: BrowserContext;
  close(): Promise<void>;
}>;

function assertPersistentProfile(
  input: PersistentProfileRequest,
  authority: PersistentProfileAuthority,
): void {
  if (input.projectId !== authority.projectId)
    throw new Error('profile reference project mismatch');
  if (input.profileId !== authority.profileId) throw new Error('profile reference ID mismatch');
  const expectedPrefix = `projects/${authority.projectId}/browser-profiles/`;
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
  onCleanupError?: (errors: readonly unknown[]) => void | Promise<void>;
}) {
  const consumedCredentials = new Set<string>();
  const closeBrowserOnAbort = options.closeBrowserOnAbort ?? true;

  const sessionFor = async (
    context: BrowserContext,
    signal: AbortSignal,
  ): Promise<BrowserSession> => {
    const page = await context.newPage();
    let pageContextCleanup: Promise<PromiseSettledResult<void>[]> | undefined;
    let browserCleanup: Promise<PromiseSettledResult<void>[]> | undefined;
    let cleanupErrorsReported = false;
    const cleanup = async (closeBrowser: boolean, surfaceErrors: boolean) => {
      signal.removeEventListener('abort', onAbort);
      pageContextCleanup ??= Promise.allSettled([
        Promise.resolve().then(() => page.close()),
        Promise.resolve().then(() => context.close()),
      ]);
      if (closeBrowser) {
        browserCleanup ??= Promise.allSettled([
          Promise.resolve().then(() => options.browser.close()),
        ]);
      }
      const resultGroups = await Promise.all([
        pageContextCleanup,
        ...(browserCleanup === undefined ? [] : [browserCleanup]),
      ]);
      const results = resultGroups.flat();
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) {
        if (!cleanupErrorsReported) {
          cleanupErrorsReported = true;
          await options.onCleanupError?.(errors);
        }
        if (surfaceErrors) throw new AggregateError(errors, 'browser cleanup failed');
      }
    };
    const close = () => cleanup(false, true);
    const onAbort = () => {
      void cleanup(closeBrowserOnAbort, false).catch(() => undefined);
    };
    if (signal.aborted) {
      await cleanup(closeBrowserOnAbort, false);
      throw new Error('browser execution aborted');
    }
    signal.addEventListener('abort', onAbort, { once: true });
    return { page, context, close };
  };

  return {
    async openTemporary(signal: AbortSignal): Promise<BrowserSession> {
      return sessionFor(await options.browser.newContext(), signal);
    },
    async openPersistent(
      input: PersistentProfileRequest,
      authority: PersistentProfileAuthority,
      signal: AbortSignal,
    ): Promise<BrowserSession> {
      assertPersistentProfile(input, authority);
      const credentialHash = createHash('sha256').update(input.brokerCredential).digest('hex');
      if (consumedCredentials.has(credentialHash)) throw new Error('reused broker credential');
      consumedCredentials.add(credentialHash);
      if (!options.profileBroker) throw new Error('persistent profile broker is unavailable');
      const profile = await options.profileBroker.fetchEncryptedProfile(input);
      return sessionFor(
        await options.browser.newContext({ storageState: profile.storageState }),
        signal,
      );
    },
  };
}
