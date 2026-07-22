import { createHash } from 'node:crypto';

export interface BrowserPage {
  close(): Promise<void>;
}

export interface BrowserRoute {
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string };
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  newContext(options?: {
    acceptDownloads?: boolean;
    serviceWorkers?: 'allow' | 'block';
    storageState?: unknown;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

export type PersistentProfileRequest = Readonly<{
  brokerCredential: string;
}>;

export type PersistentProfileAuthority = Readonly<{
  projectId: string;
  profileId: string;
  jobId: string;
  leaseId: string;
  killSwitchGeneration: number;
}>;

export type BrokeredPersistentProfile = Readonly<
  PersistentProfileAuthority & {
    status: 'active' | 'revoked' | 'expired';
    expiresAt: string | null;
    revokedAt: string | null;
    sealedStateRef: string;
    stateHash: string;
    storageState: unknown;
  }
>;

export interface BrowserProfileBroker {
  /**
   * Atomically consumes the credential for this exact authority and returns only
   * an active, unexpired, unrevoked profile whose sealed state hash was verified.
   */
  consumePersistentProfile(
    input: PersistentProfileRequest & PersistentProfileAuthority,
  ): Promise<BrokeredPersistentProfile | null>;
}

export type BrowserSession = Readonly<{
  page: BrowserPage;
  context: BrowserContext;
  close(): Promise<void>;
}>;

function canonicalStorageState(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('profile storage state is not valid JSON');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalStorageState(item));
  if (typeof value !== 'object') throw new Error('profile storage state is not valid JSON');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('profile storage state is not valid JSON');
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalStorageState(entry)]),
  );
}

export function browserStorageStateHash(storageState: unknown): `sha256:${string}` {
  const canonical = JSON.stringify(canonicalStorageState(storageState));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function assertAuthority(authority: PersistentProfileAuthority): void {
  if (
    authority.projectId.trim().length === 0 ||
    authority.profileId.trim().length === 0 ||
    authority.jobId.trim().length === 0 ||
    authority.leaseId.trim().length === 0 ||
    !Number.isSafeInteger(authority.killSwitchGeneration) ||
    authority.killSwitchGeneration < 0
  ) {
    throw new Error('persistent profile authority is invalid');
  }
}

function validatedStorageState(
  profile: BrokeredPersistentProfile,
  authority: PersistentProfileAuthority,
): unknown {
  if (
    profile.projectId !== authority.projectId ||
    profile.profileId !== authority.profileId ||
    profile.jobId !== authority.jobId ||
    profile.leaseId !== authority.leaseId ||
    profile.killSwitchGeneration !== authority.killSwitchGeneration
  ) {
    throw new Error('persistent profile broker binding mismatch');
  }
  if (profile.status !== 'active') throw new Error('persistent profile is not active');
  if (profile.revokedAt !== null) throw new Error('persistent profile is revoked');
  if (profile.expiresAt !== null) {
    const expiresAt = Date.parse(profile.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error('persistent profile is expired');
    }
  }
  if (!/^sealed:[A-Za-z0-9][A-Za-z0-9._:/-]{0,2040}$/.test(profile.sealedStateRef)) {
    throw new Error('persistent profile reference must be sealed');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(profile.stateHash)) {
    throw new Error('persistent profile state hash is invalid');
  }
  const storageState = structuredClone(profile.storageState);
  if (browserStorageStateHash(storageState) !== profile.stateHash) {
    throw new Error('persistent profile state hash mismatch');
  }
  return storageState;
}

export function createBrowserContextManager(options: {
  browser: BrowserAdapter;
  profileBroker?: BrowserProfileBroker;
  closeBrowserOnAbort?: boolean;
  onCleanupError?: (errors: readonly unknown[]) => void | Promise<void>;
  prepareContext?: (context: BrowserContext) => Promise<void>;
}) {
  const closeBrowserOnAbort = options.closeBrowserOnAbort ?? true;

  const sessionFor = async (
    context: BrowserContext,
    signal: AbortSignal,
  ): Promise<BrowserSession> => {
    let page: BrowserPage;
    try {
      await options.prepareContext?.(context);
      page = await context.newPage();
    } catch (error) {
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => context.close())]);
      const cleanupErrors = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (error instanceof Error && cleanupErrors.length > 0 && error.cause === undefined) {
        Object.defineProperty(error, 'cause', {
          configurable: true,
          value: new AggregateError(cleanupErrors, 'browser context allocation cleanup failed'),
        });
      }
      throw error;
    }
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
      return sessionFor(
        await options.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' }),
        signal,
      );
    },
    async openPersistent(
      input: PersistentProfileRequest,
      authority: PersistentProfileAuthority,
      signal: AbortSignal,
    ): Promise<BrowserSession> {
      if (
        typeof input.brokerCredential !== 'string' ||
        input.brokerCredential.trim().length === 0
      ) {
        throw new Error('broker credential is required');
      }
      assertAuthority(authority);
      if (!options.profileBroker) throw new Error('persistent profile broker is unavailable');
      const profile = await options.profileBroker.consumePersistentProfile({
        ...authority,
        ...input,
      });
      if (profile === null) {
        throw new Error('persistent profile credential is invalid, expired, or already consumed');
      }
      const storageState = validatedStorageState(profile, authority);
      return sessionFor(
        await options.browser.newContext({
          acceptDownloads: false,
          serviceWorkers: 'block',
          storageState,
        }),
        signal,
      );
    },
  };
}
