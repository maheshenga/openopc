import { randomUUID } from 'node:crypto';

import { satisfies, valid, validRange } from 'semver';

import {
  ReleaseProfileUnavailableError,
  type RuntimeReleaseProfile,
  assertRuntimeCapability,
  loadRuntimeReleaseProfile,
} from '../release-profile/runtime';
import {
  DeveloperModuleDistributionError,
  type DeveloperModuleDistributionService,
} from './distribution';
import {
  type ModuleVerificationPort,
  verifyDeveloperModuleReleaseTrustSignature,
} from './module-signing';
import type { DeveloperModuleRelease } from './releases';

export type ProjectModuleInstallationStatus = 'active' | 'blocked';
export type ProjectModuleInstallationAction = 'install' | 'update' | 'rollback';

export interface ProjectModuleInstallation {
  installation_id: string;
  project_id: string;
  account_id: string;
  module_id: string;
  active_release_id: string;
  active_version: string;
  install_revision: number;
  status: ProjectModuleInstallationStatus;
  installed_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectModuleInstallationEvent {
  installation_event_id: string;
  installation_id: string;
  project_id: string;
  account_id: string;
  sequence: number;
  action: ProjectModuleInstallationAction;
  from_release_id: string | null;
  to_release_id: string;
  expected_revision: number;
  resulting_revision: number;
  idempotency_key: string | null;
  actor_user_id: string;
  created_at: string;
}

export interface ProjectModuleInstallCommand {
  accountId: string;
  projectId: string;
  actorUserId: string;
  releaseId: string;
  expectedInstallRevision: 0;
  idempotencyKey?: string;
}

export interface ProjectModuleMoveCommand {
  accountId: string;
  projectId: string;
  moduleId: string;
  actorUserId: string;
  releaseId: string;
  action: 'update' | 'rollback';
  expectedInstallRevision: number;
  idempotencyKey?: string;
}

export interface ProjectModuleIdempotencyLookup {
  accountId: string;
  projectId: string;
  idempotencyKey: string;
  action: ProjectModuleInstallationAction;
  releaseId: string;
}

export interface ProjectModuleInstallationTransition {
  installation: ProjectModuleInstallation;
  event: ProjectModuleInstallationEvent;
}

export type ProjectModuleInstallPersistenceCommand = ProjectModuleInstallCommand & {
  moduleId: string;
  moduleVersion: string;
};

export type ProjectModuleMovePersistenceCommand = ProjectModuleMoveCommand & {
  moduleVersion: string;
  fromReleaseId: string;
};

export interface ProjectModuleInstallationRepository {
  list(accountId: string, projectId: string): Promise<readonly ProjectModuleInstallation[]>;
  get(
    accountId: string,
    projectId: string,
    moduleId: string,
  ): Promise<ProjectModuleInstallation | null>;
  install(
    command: ProjectModuleInstallPersistenceCommand,
  ): Promise<ProjectModuleInstallationTransition>;
  move(command: ProjectModuleMovePersistenceCommand): Promise<ProjectModuleInstallationTransition>;
  history(installationId: string): Promise<readonly ProjectModuleInstallationEvent[]>;
  hasHistoricalTarget(installationId: string, releaseId: string): Promise<boolean>;
  findIdempotentResult(
    input: ProjectModuleIdempotencyLookup,
  ): Promise<ProjectModuleInstallationTransition | null>;
}

export type ProjectModuleInstallationErrorCode =
  | 'PROJECT_MODULE_INSTALL_INPUT_INVALID'
  | 'PROJECT_MODULE_INSTALL_CONFLICT'
  | 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID'
  | 'PROJECT_MODULE_NOT_FOUND';

export class ProjectModuleInstallationError extends Error {
  constructor(
    readonly code: ProjectModuleInstallationErrorCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = 'ProjectModuleInstallationError';
  }
}

function fail(
  code: ProjectModuleInstallationErrorCode,
  status: ProjectModuleInstallationError['status'],
): never {
  throw new ProjectModuleInstallationError(code, status);
}

function cloneInstallation(installation: ProjectModuleInstallation): ProjectModuleInstallation {
  return structuredClone(installation);
}

function cloneEvent(event: ProjectModuleInstallationEvent): ProjectModuleInstallationEvent {
  return structuredClone(event);
}

function cloneTransition(
  transition: ProjectModuleInstallationTransition,
): ProjectModuleInstallationTransition {
  return {
    installation: cloneInstallation(transition.installation),
    event: cloneEvent(transition.event),
  };
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('PROJECT_MODULE_INSTALL_INPUT_INVALID', 400);
  }
  return value;
}

function compatibilityRanges(release: DeveloperModuleRelease): {
  platform: string;
  registry?: string;
} | null {
  const manifest = release.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const compatibility = (manifest as unknown as Record<string, unknown>).compatibility;
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
    return null;
  }
  const candidate = compatibility as Record<string, unknown>;
  if (typeof candidate.platform !== 'string') return null;
  if (candidate.registry !== undefined && typeof candidate.registry !== 'string') return null;
  return {
    platform: candidate.platform,
    ...(typeof candidate.registry === 'string' ? { registry: candidate.registry } : {}),
  };
}

export class ProjectModuleInstallationService {
  private readonly verifiers: ReadonlyMap<string, ModuleVerificationPort>;

  constructor(
    private readonly input: {
      repository: ProjectModuleInstallationRepository;
      releaseService: Pick<DeveloperModuleDistributionService, 'getPublished'>;
      verifiers?: readonly ModuleVerificationPort[];
      platformVersion?: string;
      registryVersion?: string;
      runtime?: RuntimeReleaseProfile;
    },
  ) {
    this.verifiers = new Map((input.verifiers ?? []).map((verifier) => [verifier.keyId, verifier]));
  }

  private async publishedRelease(
    releaseId: string,
    rollbackTarget: boolean,
  ): Promise<DeveloperModuleRelease> {
    try {
      return await this.input.releaseService.getPublished({ releaseId });
    } catch (error) {
      if (
        rollbackTarget &&
        error instanceof DeveloperModuleDistributionError &&
        [
          'DEVELOPER_MODULE_REVOKED',
          'DEVELOPER_MODULE_NOT_PUBLISHED',
          'DEVELOPER_RELEASE_NOT_FOUND',
        ].includes(error.code)
      ) {
        fail('PROJECT_MODULE_ROLLBACK_TARGET_INVALID', 409);
      }
      throw error;
    }
  }

  private async verifyRelease(release: DeveloperModuleRelease): Promise<void> {
    if (
      release.signature_algorithm !== 'ed25519' ||
      !release.signature_key_id ||
      !release.signature ||
      !release.signature_payload_digest ||
      !release.signed_at ||
      !/^base64url:[A-Za-z0-9_-]{86}$/.test(release.signature)
    ) {
      throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_SIGNATURE_INVALID', 409);
    }
    const verifier = this.verifiers.get(release.signature_key_id);
    if (!verifier) {
      throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
    }
    if (!(await verifyDeveloperModuleReleaseTrustSignature(release, verifier))) {
      throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_SIGNATURE_INVALID', 409);
    }

    const compatibility = compatibilityRanges(release);
    if (
      !compatibility ||
      !valid(this.input.platformVersion ?? '1.0.0') ||
      !valid(this.input.registryVersion ?? '1.0.0') ||
      !validRange(compatibility.platform) ||
      !satisfies(this.input.platformVersion ?? '1.0.0', compatibility.platform, {
        includePrerelease: true,
      }) ||
      (compatibility.registry !== undefined &&
        (!validRange(compatibility.registry) ||
          !satisfies(this.input.registryVersion ?? '1.0.0', compatibility.registry, {
            includePrerelease: true,
          })))
    ) {
      throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_NOT_DISTRIBUTABLE', 409);
    }
  }

  private async replay(input: ProjectModuleIdempotencyLookup) {
    const transition = await this.input.repository.findIdempotentResult(input);
    if (!transition) return null;
    if (
      transition.event.action !== input.action ||
      transition.event.to_release_id !== input.releaseId
    ) {
      fail('PROJECT_MODULE_INSTALL_CONFLICT', 409);
    }
    transition.installation.status = await this.currentStatus(transition.installation);
    return transition;
  }

  private async currentStatus(
    installation: ProjectModuleInstallation,
  ): Promise<ProjectModuleInstallationStatus> {
    try {
      await this.input.releaseService.getPublished({ releaseId: installation.active_release_id });
      return 'active';
    } catch (error) {
      if (
        error instanceof DeveloperModuleDistributionError ||
        error instanceof ReleaseProfileUnavailableError
      )
        return 'blocked';
      throw error;
    }
  }

  async list(input: { accountId: string; projectId: string }) {
    const installations = await this.input.repository.list(input.accountId, input.projectId);
    return Promise.all(
      installations.map(async (installation) => ({
        ...cloneInstallation(installation),
        status: await this.currentStatus(installation),
      })),
    );
  }

  async history(input: {
    accountId: string;
    projectId: string;
    moduleId: string;
  }): Promise<readonly ProjectModuleInstallationEvent[]> {
    const installation = await this.input.repository.get(
      input.accountId,
      input.projectId,
      input.moduleId,
    );
    if (!installation) fail('PROJECT_MODULE_NOT_FOUND', 404);
    return (await this.input.repository.history(installation.installation_id)).map(cloneEvent);
  }

  async install(
    command: ProjectModuleInstallCommand,
  ): Promise<ProjectModuleInstallationTransition> {
    assertRuntimeCapability('module.wasi.execute', this.input.runtime ?? loadRuntimeReleaseProfile());
    await this.publishedRelease(command.releaseId, false);
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    if (idempotencyKey) {
      const replay = await this.replay({
        accountId: command.accountId,
        projectId: command.projectId,
        idempotencyKey,
        action: 'install',
        releaseId: command.releaseId,
      });
      if (replay) return replay;
    }
    if (command.expectedInstallRevision !== 0) fail('PROJECT_MODULE_INSTALL_CONFLICT', 409);
    const release = await this.publishedRelease(command.releaseId, false);
    await this.verifyRelease(release);
    return this.input.repository.install({
      ...command,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      moduleId: release.module_id,
      moduleVersion: release.module_version,
    });
  }

  async update(
    command: Omit<ProjectModuleMoveCommand, 'action'>,
  ): Promise<ProjectModuleInstallationTransition> {
    assertRuntimeCapability('module.wasi.execute', this.input.runtime ?? loadRuntimeReleaseProfile());
    return this.move({ ...command, action: 'update' });
  }

  async rollback(
    command: Omit<ProjectModuleMoveCommand, 'action'>,
  ): Promise<ProjectModuleInstallationTransition> {
    assertRuntimeCapability('module.wasi.execute', this.input.runtime ?? loadRuntimeReleaseProfile());
    return this.move({ ...command, action: 'rollback' });
  }

  private async move(
    command: ProjectModuleMoveCommand,
  ): Promise<ProjectModuleInstallationTransition> {
    await this.publishedRelease(command.releaseId, command.action === 'rollback');
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    if (idempotencyKey) {
      const replay = await this.replay({
        accountId: command.accountId,
        projectId: command.projectId,
        idempotencyKey,
        action: command.action,
        releaseId: command.releaseId,
      });
      if (replay) return replay;
    }
    const installation = await this.input.repository.get(
      command.accountId,
      command.projectId,
      command.moduleId,
    );
    if (!installation) fail('PROJECT_MODULE_NOT_FOUND', 404);
    if (
      installation.install_revision !== command.expectedInstallRevision ||
      installation.active_release_id === command.releaseId
    ) {
      fail('PROJECT_MODULE_INSTALL_CONFLICT', 409);
    }
    if (
      command.action === 'rollback' &&
      !(await this.input.repository.hasHistoricalTarget(
        installation.installation_id,
        command.releaseId,
      ))
    ) {
      fail('PROJECT_MODULE_ROLLBACK_TARGET_INVALID', 409);
    }
    const release = await this.publishedRelease(command.releaseId, command.action === 'rollback');
    await this.verifyRelease(release);
    if (release.module_id !== command.moduleId) fail('PROJECT_MODULE_INSTALL_CONFLICT', 409);
    return this.input.repository.move({
      ...command,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      moduleVersion: release.module_version,
      fromReleaseId: installation.active_release_id,
    });
  }
}

export function createMemoryProjectModuleInstallationRepository(input?: {
  installations?: readonly ProjectModuleInstallation[];
  events?: readonly ProjectModuleInstallationEvent[];
  now?: () => Date;
  createId?: () => string;
}): ProjectModuleInstallationRepository {
  const installationMap = new Map<string, ProjectModuleInstallation>();
  const events = new Map<string, ProjectModuleInstallationEvent[]>();
  const idempotency = new Map<string, ProjectModuleInstallationTransition>();
  const now = input?.now ?? (() => new Date());
  const createId = input?.createId ?? randomUUID;
  const key = (accountId: string, projectId: string, moduleId: string) =>
    `${accountId}\0${projectId}\0${moduleId}`;
  const idempotencyKey = (accountId: string, projectId: string, value: string) =>
    `${accountId}\0${projectId}\0${value}`;

  for (const installation of input?.installations ?? []) {
    installationMap.set(
      key(installation.account_id, installation.project_id, installation.module_id),
      cloneInstallation(installation),
    );
  }
  for (const event of input?.events ?? []) {
    const history = events.get(event.installation_id) ?? [];
    history.push(cloneEvent(event));
    events.set(event.installation_id, history);
    if (event.idempotency_key) {
      const installation = [...installationMap.values()].find(
        (candidate) => candidate.installation_id === event.installation_id,
      );
      if (installation) {
        idempotency.set(idempotencyKey(event.account_id, event.project_id, event.idempotency_key), {
          installation: cloneInstallation(installation),
          event: cloneEvent(event),
        });
      }
    }
  }

  function conflict(): never {
    fail('PROJECT_MODULE_INSTALL_CONFLICT', 409);
  }

  function storeTransition(
    transition: ProjectModuleInstallationTransition,
    commandIdempotencyKey?: string,
  ) {
    installationMap.set(
      key(
        transition.installation.account_id,
        transition.installation.project_id,
        transition.installation.module_id,
      ),
      cloneInstallation(transition.installation),
    );
    const history = events.get(transition.installation.installation_id) ?? [];
    history.push(cloneEvent(transition.event));
    events.set(transition.installation.installation_id, history);
    if (commandIdempotencyKey) {
      idempotency.set(
        idempotencyKey(
          transition.installation.account_id,
          transition.installation.project_id,
          commandIdempotencyKey,
        ),
        cloneTransition(transition),
      );
    }
  }

  return {
    async list(accountId, projectId) {
      return [...installationMap.values()]
        .filter(
          (installation) =>
            installation.account_id === accountId && installation.project_id === projectId,
        )
        .sort((left, right) => left.module_id.localeCompare(right.module_id))
        .map(cloneInstallation);
    },

    async history(installationId) {
      return (events.get(installationId) ?? [])
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneEvent);
    },

    async get(accountId, projectId, moduleId) {
      const installation = installationMap.get(key(accountId, projectId, moduleId));
      return installation ? cloneInstallation(installation) : null;
    },

    async install(command) {
      if (command.idempotencyKey) {
        const prior = idempotency.get(
          idempotencyKey(command.accountId, command.projectId, command.idempotencyKey),
        );
        if (prior) {
          if (prior.event.action !== 'install' || prior.event.to_release_id !== command.releaseId) {
            conflict();
          }
          return cloneTransition(prior);
        }
      }
      if (command.expectedInstallRevision !== 0) conflict();
      const installationKey = key(command.accountId, command.projectId, command.moduleId);
      if (installationMap.has(installationKey)) conflict();
      const createdAt = now().toISOString();
      const installation: ProjectModuleInstallation = {
        installation_id: createId(),
        project_id: command.projectId,
        account_id: command.accountId,
        module_id: command.moduleId,
        active_release_id: command.releaseId,
        active_version: command.moduleVersion,
        install_revision: 1,
        status: 'active',
        installed_by: command.actorUserId,
        created_at: createdAt,
        updated_at: createdAt,
      };
      const event: ProjectModuleInstallationEvent = {
        installation_event_id: createId(),
        installation_id: installation.installation_id,
        project_id: command.projectId,
        account_id: command.accountId,
        sequence: 1,
        action: 'install',
        from_release_id: null,
        to_release_id: command.releaseId,
        expected_revision: 0,
        resulting_revision: 1,
        idempotency_key: command.idempotencyKey ?? null,
        actor_user_id: command.actorUserId,
        created_at: createdAt,
      };
      const transition = { installation, event };
      storeTransition(transition, command.idempotencyKey);
      return cloneTransition(transition);
    },

    async move(command) {
      if (command.idempotencyKey) {
        const prior = idempotency.get(
          idempotencyKey(command.accountId, command.projectId, command.idempotencyKey),
        );
        if (prior) {
          if (
            prior.event.action !== command.action ||
            prior.event.to_release_id !== command.releaseId
          ) {
            conflict();
          }
          return cloneTransition(prior);
        }
      }
      const installationKey = key(command.accountId, command.projectId, command.moduleId);
      const current = installationMap.get(installationKey);
      if (!current) fail('PROJECT_MODULE_NOT_FOUND', 404);
      if (
        current.install_revision !== command.expectedInstallRevision ||
        current.active_release_id === command.releaseId
      ) {
        conflict();
      }
      const createdAt = now().toISOString();
      const installation: ProjectModuleInstallation = {
        ...cloneInstallation(current),
        active_release_id: command.releaseId,
        active_version: command.moduleVersion,
        install_revision: current.install_revision + 1,
        status: 'active',
        updated_at: createdAt,
      };
      const event: ProjectModuleInstallationEvent = {
        installation_event_id: createId(),
        installation_id: current.installation_id,
        project_id: command.projectId,
        account_id: command.accountId,
        sequence: installation.install_revision,
        action: command.action,
        from_release_id: current.active_release_id,
        to_release_id: command.releaseId,
        expected_revision: command.expectedInstallRevision,
        resulting_revision: installation.install_revision,
        idempotency_key: command.idempotencyKey ?? null,
        actor_user_id: command.actorUserId,
        created_at: createdAt,
      };
      const transition = { installation, event };
      storeTransition(transition, command.idempotencyKey);
      return cloneTransition(transition);
    },

    async hasHistoricalTarget(installationId, releaseId) {
      return (events.get(installationId) ?? []).some((event) => event.to_release_id === releaseId);
    },

    async findIdempotentResult(input) {
      const transition = idempotency.get(
        idempotencyKey(input.accountId, input.projectId, input.idempotencyKey),
      );
      return transition ? cloneTransition(transition) : null;
    },
  };
}
