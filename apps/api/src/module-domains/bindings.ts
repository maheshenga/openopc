import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Resolver,
  resolve4 as nodeResolve4,
  resolve6 as nodeResolve6,
  resolveNs as nodeResolveNs,
} from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_RE = /^base64url:[A-Za-z0-9_-]{86}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TXT_PREFIX = '_openopc-verification.';
const VERIFICATION_PREFIX = 'openopc-domain-verification=';

export type ModuleCustomDomainBindingState =
  | 'requested'
  | 'dns_pending'
  | 'hostname_pending'
  | 'active'
  | 'failed'
  | 'disabled';

export type ModuleCustomDomainEnvironment = 'dev' | 'staging' | 'prod' | 'preview';

export type ModuleCustomDomainBindingErrorCode =
  | 'MODULE_DOMAIN_INPUT_INVALID'
  | 'MODULE_DOMAIN_UNAVAILABLE'
  | 'MODULE_DOMAIN_INSTALLATION_NOT_FOUND'
  | 'MODULE_DOMAIN_INSTALLATION_STALE'
  | 'MODULE_DOMAIN_RELEASE_NOT_ELIGIBLE'
  | 'MODULE_DOMAIN_HOSTNAME_FORBIDDEN'
  | 'MODULE_DOMAIN_HOSTNAME_CONFLICT'
  | 'MODULE_DOMAIN_NOT_FOUND'
  | 'MODULE_DOMAIN_DNS_PENDING'
  | 'MODULE_DOMAIN_DNS_UNAVAILABLE'
  | 'MODULE_DOMAIN_PROVIDER_UNAVAILABLE'
  | 'MODULE_DOMAIN_STATE_CONFLICT';

export class ModuleCustomDomainBindingError extends Error {
  constructor(
    readonly code: ModuleCustomDomainBindingErrorCode,
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'ModuleCustomDomainBindingError';
  }
}

export interface ModuleCustomDomainInstallation {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  installationStatus: 'active' | 'blocked';
  releaseId: string;
  releaseAccountId: string;
  releaseStatus: string;
  releaseExecutionMode: string | null;
  signatureAlgorithm: string | null;
  signature: string | null;
  signedAt: string | null;
}

export interface ModuleCustomDomainBinding {
  bindingId: string;
  environment: ModuleCustomDomainEnvironment;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  hostname: string;
  hostnameAscii: string;
  state: ModuleCustomDomainBindingState;
  verificationTokenHash: `sha256:${string}`;
  cloudflareCustomHostnameId: string | null;
  cnameTarget: string;
  failureCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleCustomDomainBindingView {
  bindingId: string;
  installationId: string;
  releaseId: string;
  hostname: string;
  hostnameAscii: string;
  state: ModuleCustomDomainBindingState;
  cnameTarget: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleCustomDomainCreation {
  binding: ModuleCustomDomainBindingView;
  verificationRecord: { type: 'TXT'; name: string; value: string };
  cnameRecord: { type: 'CNAME'; name: string; value: string };
}

export interface ModuleCustomDomainBindingRepository {
  resolveInstallation(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ModuleCustomDomainInstallation | null>;
  findByHostnameAscii(hostnameAscii: string): Promise<ModuleCustomDomainBinding | null>;
  create(binding: ModuleCustomDomainBinding): Promise<ModuleCustomDomainBinding>;
  list(input: {
    environment: ModuleCustomDomainEnvironment;
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<readonly ModuleCustomDomainBinding[]>;
  get(input: {
    environment: ModuleCustomDomainEnvironment;
    accountId: string;
    projectId: string;
    installationId: string;
    bindingId: string;
  }): Promise<ModuleCustomDomainBinding | null>;
  transition(input: {
    environment: ModuleCustomDomainEnvironment;
    accountId: string;
    projectId: string;
    installationId: string;
    bindingId: string;
    from: readonly ModuleCustomDomainBindingState[];
    to: ModuleCustomDomainBindingState;
    cloudflareCustomHostnameId?: string | null;
    failureCode?: string | null;
    updatedAt: string;
  }): Promise<ModuleCustomDomainBinding | null>;
  findActiveByHostnameAscii(input: {
    environment: ModuleCustomDomainEnvironment;
    hostnameAscii: string;
  }): Promise<ModuleCustomDomainBinding | null>;
}

export interface AuthoritativeDnsObservation {
  txtValues: readonly string[];
  cnameValues: readonly string[];
}

export interface AuthoritativeDnsResolverPort {
  resolve(input: { hostname: string; txtName: string }): Promise<AuthoritativeDnsObservation>;
}

export interface CloudflareCustomHostnameResult {
  id: string;
  state: 'pending' | 'active' | 'failed';
  failureCode: string | null;
}

export interface CloudflareCustomHostnamePort {
  create(hostname: string): Promise<CloudflareCustomHostnameResult>;
  get(id: string): Promise<CloudflareCustomHostnameResult>;
  delete(id: string): Promise<void>;
}

const TRANSITIONS: Readonly<
  Record<ModuleCustomDomainBindingState, ReadonlySet<ModuleCustomDomainBindingState>>
> = {
  requested: new Set(['dns_pending', 'failed', 'disabled']),
  dns_pending: new Set(['hostname_pending', 'failed', 'disabled']),
  hostname_pending: new Set(['active', 'failed', 'disabled']),
  active: new Set(['disabled']),
  failed: new Set(['disabled']),
  disabled: new Set(),
};

export function canTransitionModuleCustomDomainBinding(
  from: ModuleCustomDomainBindingState,
  to: ModuleCustomDomainBindingState,
): boolean {
  return TRANSITIONS[from].has(to);
}

function fail(
  code: ModuleCustomDomainBindingErrorCode,
  status: ModuleCustomDomainBindingError['status'],
): never {
  throw new ModuleCustomDomainBindingError(code, status);
}

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) fail('MODULE_DOMAIN_INPUT_INVALID', 400);
}

function assertEnvironment(value: string): asserts value is ModuleCustomDomainEnvironment {
  if (!['dev', 'staging', 'prod', 'preview'].includes(value)) {
    throw new TypeError('MODULE_DOMAIN_CONFIG_INVALID');
  }
}

function normalizeDnsHostname(value: string): string | null {
  const withoutRootDot = value.trim().replace(/[.]$/, '');
  if (!withoutRootDot || withoutRootDot.includes('*') || isIP(withoutRootDot) !== 0) return null;
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.includes('..')) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_RE.test(label))) return null;
  return ascii;
}

function normalizeRequestedHostname(
  value: unknown,
  platformHostnames: ReadonlySet<string>,
): { hostname: string; hostnameAscii: string } {
  if (typeof value !== 'string') fail('MODULE_DOMAIN_HOSTNAME_FORBIDDEN', 400);
  const hostname = value.trim().replace(/[.]$/, '').toLowerCase();
  const hostnameAscii = normalizeDnsHostname(hostname);
  if (
    !hostnameAscii ||
    `${TXT_PREFIX}${hostnameAscii}`.length > 253 ||
    hostnameAscii === 'localhost' ||
    hostnameAscii.endsWith('.localhost') ||
    [...platformHostnames].some(
      (platform) => hostnameAscii === platform || hostnameAscii.endsWith(`.${platform}`),
    )
  ) {
    fail('MODULE_DOMAIN_HOSTNAME_FORBIDDEN', 400);
  }
  return { hostname, hostnameAscii };
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function verificationHash(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function view(binding: ModuleCustomDomainBinding): ModuleCustomDomainBindingView {
  return {
    bindingId: binding.bindingId,
    installationId: binding.installationId,
    releaseId: binding.releaseId,
    hostname: binding.hostname,
    hostnameAscii: binding.hostnameAscii,
    state: binding.state,
    cnameTarget: binding.cnameTarget,
    failureCode: binding.failureCode,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function assertEligibleInstallation(
  current: ModuleCustomDomainInstallation,
  input: { accountId: string; projectId: string; installationId: string; installRevision: number },
): void {
  if (
    current.accountId !== input.accountId ||
    current.projectId !== input.projectId ||
    current.installationId !== input.installationId ||
    current.installRevision !== input.installRevision ||
    current.installationStatus !== 'active'
  ) {
    fail('MODULE_DOMAIN_INSTALLATION_STALE', 409);
  }
  if (
    current.releaseAccountId !== input.accountId ||
    current.releaseStatus !== 'published' ||
    current.releaseExecutionMode !== 'sandboxed-web' ||
    current.signatureAlgorithm !== 'ed25519' ||
    !current.signature ||
    !SIGNATURE_RE.test(current.signature) ||
    !current.signedAt
  ) {
    fail('MODULE_DOMAIN_RELEASE_NOT_ELIGIBLE', 409);
  }
}

function providerFailureCode(value: string | null): string {
  if (value && /^[a-z0-9._:-]{1,128}$/i.test(value)) return value.toLowerCase();
  return 'cloudflare_failed';
}

export function moduleCustomDomainRoutePath(releaseId: string): string {
  assertUuid(releaseId);
  return `/v1/module-host/releases/${releaseId.toLowerCase()}`;
}

export class ModuleCustomDomainBindingService {
  private readonly repository: ModuleCustomDomainBindingRepository;
  private readonly dns: AuthoritativeDnsResolverPort;
  private readonly cloudflare: CloudflareCustomHostnamePort;
  private readonly cnameTarget: string;
  private readonly environment: ModuleCustomDomainEnvironment;
  private readonly platformHostnames: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly createBindingId: () => string;
  private readonly createVerificationTokenBytes: () => Uint8Array;

  constructor(input: {
    repository: ModuleCustomDomainBindingRepository;
    dns: AuthoritativeDnsResolverPort;
    cloudflare: CloudflareCustomHostnamePort;
    cnameTarget: string;
    environment: ModuleCustomDomainEnvironment;
    platformHostnames?: readonly string[];
    now?: () => Date;
    createBindingId?: () => string;
    createVerificationTokenBytes?: () => Uint8Array;
  }) {
    const cnameTarget = normalizeDnsHostname(input.cnameTarget);
    if (!cnameTarget) throw new TypeError('MODULE_DOMAIN_CONFIG_INVALID');
    assertEnvironment(input.environment);
    this.repository = input.repository;
    this.dns = input.dns;
    this.cloudflare = input.cloudflare;
    this.cnameTarget = cnameTarget;
    this.environment = input.environment;
    this.platformHostnames = new Set(
      (input.platformHostnames ?? [])
        .map((hostname) => normalizeDnsHostname(hostname))
        .filter((hostname): hostname is string => hostname !== null),
    );
    this.now = input.now ?? (() => new Date());
    this.createBindingId = input.createBindingId ?? randomUUID;
    this.createVerificationTokenBytes =
      input.createVerificationTokenBytes ?? (() => randomBytes(32));
  }

  async create(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    expectedInstallRevision: number;
    hostname: unknown;
    actorUserId: string;
  }): Promise<ModuleCustomDomainCreation> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    assertUuid(input.actorUserId);
    if (
      !Number.isSafeInteger(input.expectedInstallRevision) ||
      input.expectedInstallRevision <= 0
    ) {
      fail('MODULE_DOMAIN_INPUT_INVALID', 400);
    }
    const normalized = normalizeRequestedHostname(input.hostname, this.platformHostnames);
    const current = await this.repository.resolveInstallation({
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
    });
    if (!current) fail('MODULE_DOMAIN_INSTALLATION_NOT_FOUND', 404);
    assertEligibleInstallation(current, {
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
      installRevision: input.expectedInstallRevision,
    });
    if (await this.repository.findByHostnameAscii(normalized.hostnameAscii)) {
      fail('MODULE_DOMAIN_HOSTNAME_CONFLICT', 409);
    }

    const bindingId = this.createBindingId();
    assertUuid(bindingId);
    const tokenBytes = this.createVerificationTokenBytes();
    if (!(tokenBytes instanceof Uint8Array) || tokenBytes.byteLength !== 32) {
      fail('MODULE_DOMAIN_UNAVAILABLE', 503);
    }
    const verificationValue = `${VERIFICATION_PREFIX}${Buffer.from(tokenBytes).toString('base64url')}`;
    const timestamp = this.now().toISOString();
    const requested: ModuleCustomDomainBinding = {
      bindingId,
      environment: this.environment,
      accountId: current.accountId,
      projectId: current.projectId,
      installationId: current.installationId,
      releaseId: current.releaseId,
      hostname: normalized.hostname,
      hostnameAscii: normalized.hostnameAscii,
      state: 'requested',
      verificationTokenHash: verificationHash(verificationValue),
      cloudflareCustomHostnameId: null,
      cnameTarget: this.cnameTarget,
      failureCode: null,
      createdBy: input.actorUserId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let stored: ModuleCustomDomainBinding;
    try {
      stored = await this.repository.create(requested);
    } catch (error) {
      if (error instanceof ModuleCustomDomainBindingError) throw error;
      fail('MODULE_DOMAIN_UNAVAILABLE', 503);
    }
    const pending = await this.transition(stored, ['requested'], 'dns_pending');
    return {
      binding: view(pending),
      verificationRecord: {
        type: 'TXT',
        name: `${TXT_PREFIX}${normalized.hostnameAscii}`,
        value: verificationValue,
      },
      cnameRecord: {
        type: 'CNAME',
        name: normalized.hostnameAscii,
        value: this.cnameTarget,
      },
    };
  }

  async list(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<readonly ModuleCustomDomainBindingView[]> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    const current = await this.repository.resolveInstallation(input);
    if (!current) fail('MODULE_DOMAIN_INSTALLATION_NOT_FOUND', 404);
    return (await this.repository.list({ ...input, environment: this.environment })).map(view);
  }

  async verify(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    bindingId: string;
  }): Promise<ModuleCustomDomainBindingView> {
    let binding = await this.scopedBinding(input);
    if (binding.state === 'active') return view(binding);
    if (binding.state === 'failed' || binding.state === 'disabled') {
      fail('MODULE_DOMAIN_STATE_CONFLICT', 409);
    }
    if (binding.state === 'requested') {
      binding = await this.transition(binding, ['requested'], 'dns_pending');
    }
    if (binding.state === 'dns_pending') {
      let observation: AuthoritativeDnsObservation;
      try {
        observation = await this.dns.resolve({
          hostname: binding.hostnameAscii,
          txtName: `${TXT_PREFIX}${binding.hostnameAscii}`,
        });
      } catch {
        fail('MODULE_DOMAIN_DNS_UNAVAILABLE', 503);
      }
      const txtVerified = observation.txtValues.some((value) =>
        safeEqual(verificationHash(value), binding.verificationTokenHash),
      );
      const cnameVerified = observation.cnameValues.some(
        (value) => normalizeDnsHostname(value) === this.cnameTarget,
      );
      if (!txtVerified || !cnameVerified) fail('MODULE_DOMAIN_DNS_PENDING', 409);

      let provider: CloudflareCustomHostnameResult;
      try {
        provider = await this.cloudflare.create(binding.hostnameAscii);
      } catch {
        fail('MODULE_DOMAIN_PROVIDER_UNAVAILABLE', 503);
      }
      if (!provider.id || provider.id.length > 128) {
        fail('MODULE_DOMAIN_PROVIDER_UNAVAILABLE', 503);
      }
      try {
        binding = await this.transition(binding, ['dns_pending'], 'hostname_pending', {
          cloudflareCustomHostnameId: provider.id,
        });
      } catch (error) {
        // A concurrent verifier or installation change may win the durable CAS
        // transition after Cloudflare has allocated the hostname. Compensate
        // immediately so the loser cannot strand a provider resource.
        await this.cloudflare.delete(provider.id).catch(() => undefined);
        throw error;
      }
      binding = await this.applyProviderResult(binding, provider);
      return view(binding);
    }

    if (!binding.cloudflareCustomHostnameId) fail('MODULE_DOMAIN_STATE_CONFLICT', 409);
    let provider: CloudflareCustomHostnameResult;
    try {
      provider = await this.cloudflare.get(binding.cloudflareCustomHostnameId);
    } catch {
      fail('MODULE_DOMAIN_PROVIDER_UNAVAILABLE', 503);
    }
    if (provider.id !== binding.cloudflareCustomHostnameId) {
      fail('MODULE_DOMAIN_PROVIDER_UNAVAILABLE', 503);
    }
    binding = await this.applyProviderResult(binding, provider);
    return view(binding);
  }

  async disable(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    bindingId: string;
  }): Promise<ModuleCustomDomainBindingView> {
    const binding = await this.scopedBinding(input);
    if (binding.state === 'disabled') return view(binding);
    if (binding.cloudflareCustomHostnameId) {
      try {
        await this.cloudflare.delete(binding.cloudflareCustomHostnameId);
      } catch {
        fail('MODULE_DOMAIN_PROVIDER_UNAVAILABLE', 503);
      }
    }
    return view(
      await this.transition(binding, [binding.state], 'disabled', {
        cloudflareCustomHostnameId: null,
      }),
    );
  }

  async resolve(hostname: string): Promise<{ bindingId: string; routePath: string } | null> {
    const hostnameAscii = normalizeDnsHostname(hostname);
    if (!hostnameAscii) return null;
    const binding = await this.repository.findActiveByHostnameAscii({
      environment: this.environment,
      hostnameAscii,
    });
    if (!binding || binding.state !== 'active') return null;
    return {
      bindingId: binding.bindingId,
      routePath: moduleCustomDomainRoutePath(binding.releaseId),
    };
  }

  private async scopedBinding(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    bindingId: string;
  }): Promise<ModuleCustomDomainBinding> {
    assertUuid(input.accountId);
    assertUuid(input.projectId);
    assertUuid(input.installationId);
    assertUuid(input.bindingId);
    const binding = await this.repository.get({ ...input, environment: this.environment });
    if (!binding) fail('MODULE_DOMAIN_NOT_FOUND', 404);
    return binding;
  }

  private async transition(
    binding: ModuleCustomDomainBinding,
    from: readonly ModuleCustomDomainBindingState[],
    to: ModuleCustomDomainBindingState,
    patch?: { cloudflareCustomHostnameId?: string | null; failureCode?: string | null },
  ): Promise<ModuleCustomDomainBinding> {
    if (
      !from.includes(binding.state) ||
      !canTransitionModuleCustomDomainBinding(binding.state, to)
    ) {
      fail('MODULE_DOMAIN_STATE_CONFLICT', 409);
    }
    const updated = await this.repository.transition({
      accountId: binding.accountId,
      environment: this.environment,
      projectId: binding.projectId,
      installationId: binding.installationId,
      bindingId: binding.bindingId,
      from,
      to,
      ...patch,
      updatedAt: this.now().toISOString(),
    });
    if (!updated) fail('MODULE_DOMAIN_STATE_CONFLICT', 409);
    return updated;
  }

  private async applyProviderResult(
    binding: ModuleCustomDomainBinding,
    provider: CloudflareCustomHostnameResult,
  ): Promise<ModuleCustomDomainBinding> {
    if (provider.state === 'pending') return binding;
    if (provider.state === 'active') {
      return this.transition(binding, ['hostname_pending'], 'active', { failureCode: null });
    }
    const providerId = binding.cloudflareCustomHostnameId;
    if (!providerId) fail('MODULE_DOMAIN_STATE_CONFLICT', 409);
    let cleaned = false;
    try {
      await this.cloudflare.delete(providerId);
      cleaned = true;
    } catch {
      // Keep the provider id when cleanup fails so the owner can retry DELETE.
    }
    return this.transition(binding, ['hostname_pending'], 'failed', {
      ...(cleaned ? { cloudflareCustomHostnameId: null } : {}),
      failureCode: providerFailureCode(provider.failureCode),
    });
  }
}

function installationKey(input: {
  accountId: string;
  projectId: string;
  installationId: string;
}): string {
  return `${input.accountId}\0${input.projectId}\0${input.installationId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryModuleCustomDomainBindingRepository(input?: {
  installations?: readonly ModuleCustomDomainInstallation[];
  bindings?: readonly ModuleCustomDomainBinding[];
}): ModuleCustomDomainBindingRepository {
  const installations = new Map(
    (input?.installations ?? []).map((current) => [installationKey(current), clone(current)]),
  );
  const bindings = new Map(
    (input?.bindings ?? []).map((current) => [current.bindingId, clone(current)]),
  );

  return {
    async resolveInstallation(query) {
      return clone(installations.get(installationKey(query)) ?? null);
    },
    async findByHostnameAscii(hostnameAscii) {
      const found = [...bindings.values()].find(
        (current) => current.hostnameAscii === hostnameAscii,
      );
      return clone(found ?? null);
    },
    async create(value) {
      if (
        bindings.has(value.bindingId) ||
        [...bindings.values()].some((current) => current.hostnameAscii === value.hostnameAscii)
      ) {
        fail('MODULE_DOMAIN_HOSTNAME_CONFLICT', 409);
      }
      bindings.set(value.bindingId, clone(value));
      return clone(value);
    },
    async list(query) {
      return [...bindings.values()]
        .filter(
          (current) =>
            current.environment === query.environment &&
            current.accountId === query.accountId &&
            current.projectId === query.projectId &&
            current.installationId === query.installationId,
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.bindingId.localeCompare(left.bindingId),
        )
        .map(clone);
    },
    async get(query) {
      const current = bindings.get(query.bindingId);
      if (
        !current ||
        current.environment !== query.environment ||
        current.accountId !== query.accountId ||
        current.projectId !== query.projectId ||
        current.installationId !== query.installationId
      ) {
        return null;
      }
      return clone(current);
    },
    async transition(command) {
      const current = bindings.get(command.bindingId);
      if (
        !current ||
        current.environment !== command.environment ||
        current.accountId !== command.accountId ||
        current.projectId !== command.projectId ||
        current.installationId !== command.installationId ||
        !command.from.includes(current.state) ||
        !canTransitionModuleCustomDomainBinding(current.state, command.to)
      ) {
        return null;
      }
      const updated: ModuleCustomDomainBinding = {
        ...current,
        state: command.to,
        ...(command.cloudflareCustomHostnameId !== undefined
          ? { cloudflareCustomHostnameId: command.cloudflareCustomHostnameId }
          : {}),
        ...(command.failureCode !== undefined ? { failureCode: command.failureCode } : {}),
        updatedAt: command.updatedAt,
      };
      bindings.set(updated.bindingId, clone(updated));
      return clone(updated);
    },
    async findActiveByHostnameAscii(query) {
      const current = [...bindings.values()].find(
        (candidate) =>
          candidate.environment === query.environment &&
          candidate.hostnameAscii === query.hostnameAscii &&
          candidate.state === 'active',
      );
      if (!current) return null;
      const installed = installations.get(installationKey(current));
      if (
        !installed ||
        installed.releaseId !== current.releaseId ||
        installed.releaseAccountId !== current.accountId ||
        installed.installationStatus !== 'active' ||
        installed.releaseStatus !== 'published' ||
        installed.releaseExecutionMode !== 'sandboxed-web' ||
        installed.signatureAlgorithm !== 'ed25519' ||
        !installed.signature ||
        !installed.signedAt
      ) {
        return null;
      }
      return clone(current);
    },
  };
}

interface ResolverLike {
  setServers(servers: string[]): void;
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
}

export function createNodeAuthoritativeDnsResolver(input?: {
  resolveNs?: (hostname: string) => Promise<string[]>;
  resolve4?: (hostname: string) => Promise<string[]>;
  resolve6?: (hostname: string) => Promise<string[]>;
  createResolver?: () => ResolverLike;
}): AuthoritativeDnsResolverPort {
  const resolveNs = input?.resolveNs ?? nodeResolveNs;
  const resolve4 = input?.resolve4 ?? nodeResolve4;
  const resolve6 = input?.resolve6 ?? nodeResolve6;
  const createResolver = input?.createResolver ?? (() => new Resolver());

  return {
    async resolve(query) {
      const labels = query.hostname.split('.');
      let nameservers: string[] = [];
      for (let index = 0; index <= labels.length - 2; index += 1) {
        try {
          nameservers = await resolveNs(labels.slice(index).join('.'));
          if (nameservers.length > 0) break;
        } catch {
          nameservers = [];
        }
      }
      if (nameservers.length === 0) throw new Error('MODULE_DOMAIN_DNS_UNAVAILABLE');

      const addresses = (
        await Promise.all(
          nameservers.map(async (nameserver) => {
            const hostname = nameserver.replace(/[.]$/, '');
            const [ipv4, ipv6] = await Promise.all([
              resolve4(hostname).catch(() => []),
              resolve6(hostname).catch(() => []),
            ]);
            return [...ipv4, ...ipv6];
          }),
        )
      ).flat();
      if (addresses.length === 0) throw new Error('MODULE_DOMAIN_DNS_UNAVAILABLE');

      const resolver = createResolver();
      resolver.setServers([...new Set(addresses)]);
      const [txt, cname] = await Promise.all([
        resolver.resolveTxt(query.txtName).catch(() => []),
        resolver.resolveCname(query.hostname).catch(() => []),
      ]);
      return {
        txtValues: txt.map((chunks) => chunks.join('')),
        cnameValues: [...cname],
      };
    },
  };
}

export function isModuleCustomDomainVerificationHash(value: string): boolean {
  return SHA256_RE.test(value);
}
