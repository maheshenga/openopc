'use client';

import type {
  ProjectModuleInstallation,
  ProjectModuleInstallationEvent,
  ProjectModuleInstallationTransition,
} from '@kortix/sdk';
import { History, PackageOpen, RotateCcw, ShieldCheck, Upload, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import type {
  ModuleServiceConsent,
  OpenOpcServiceName,
  OpenOpcServiceOperation,
  PublishedProjectModuleRelease,
} from './client';
import { moduleServiceDeclarations } from './client';
import { ModuleServiceConsentDialog } from './module-service-consent-dialog';
import {
  projectModuleErrorCode,
  useGrantProjectModuleServiceConsent,
  useInstallProjectModule,
  useProjectModuleHistories,
  useProjectModuleMutation,
  useProjectModuleReleases,
  useProjectModuleServiceConsentsForInstallations,
  useProjectModules,
  useRevokeProjectModuleServiceConsent,
} from './query';

export type { PublishedProjectModuleRelease } from './client';

export type ProjectModulesPageState = 'loading' | 'error' | 'empty' | 'ready';

export function projectModuleRollbackTargets(
  installation: ProjectModuleInstallation,
  releases: readonly PublishedProjectModuleRelease[],
  history: readonly ProjectModuleInstallationEvent[],
): PublishedProjectModuleRelease[] {
  const releaseById = new Map(releases.map((release) => [release.release_id, release]));
  const seen = new Set<string>();
  return [...history]
    .sort((left, right) => right.sequence - left.sequence)
    .map((event) => event.to_release_id)
    .filter((releaseId) => releaseId !== installation.active_release_id)
    .filter((releaseId) => {
      if (seen.has(releaseId)) return false;
      seen.add(releaseId);
      return true;
    })
    .map((releaseId) => releaseById.get(releaseId))
    .filter((release): release is PublishedProjectModuleRelease => release !== undefined);
}

function dateLabel(value: string | null): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

function errorMessage(code: string | null): string {
  if (code === 'PROJECT_MODULE_INSTALL_CONFLICT') {
    return 'This module changed in another session. Reload the installed modules before trying again.';
  }
  if (code === 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID') {
    return 'That rollback target is no longer available in the installation history.';
  }
  if (code === 'DEVELOPER_MODULE_REVOKED') {
    return 'The selected release has been revoked and cannot be installed.';
  }
  return 'Installed modules could not be loaded. Try again.';
}

export interface ProjectModulesViewProps {
  state: ProjectModulesPageState;
  modules: readonly ProjectModuleInstallation[];
  releases: readonly PublishedProjectModuleRelease[];
  historyByInstallation: Readonly<Record<string, readonly ProjectModuleInstallationEvent[]>>;
  canWrite: boolean;
  pendingModuleId: string | null;
  errorCode: string | null;
  serviceConsentsByInstallation?: Readonly<Record<string, readonly ModuleServiceConsent[]>>;
  pendingServiceKey?: string | null;
  onInstall: (releaseId: string) => void;
  onUpdate: (moduleId: string, releaseId: string, revision: number) => void;
  onRollback: (moduleId: string, releaseId: string, revision: number) => void;
  onGrantServiceConsent?: (
    installation: ProjectModuleInstallation,
    service: OpenOpcServiceName,
    operations: readonly OpenOpcServiceOperation[],
  ) => void;
  onRevokeServiceConsent?: (
    installation: ProjectModuleInstallation,
    service: OpenOpcServiceName,
  ) => void;
  onReload: () => void;
}

export function ProjectModulesView({
  state,
  modules,
  releases,
  historyByInstallation,
  canWrite,
  pendingModuleId,
  errorCode,
  serviceConsentsByInstallation = {},
  pendingServiceKey = null,
  onInstall,
  onUpdate,
  onRollback,
  onGrantServiceConsent,
  onRevokeServiceConsent,
  onReload,
}: ProjectModulesViewProps) {
  const [installTarget, setInstallTarget] = useState<PublishedProjectModuleRelease | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    kind: 'update' | 'rollback';
    moduleId: string;
    release: PublishedProjectModuleRelease;
    revision: number;
  } | null>(null);
  const [historyInstallationId, setHistoryInstallationId] = useState<string | null>(null);
  const [serviceConsentTarget, setServiceConsentTarget] = useState<{
    installation: ProjectModuleInstallation;
    service: OpenOpcServiceName;
    operations: OpenOpcServiceOperation[];
    consent: ModuleServiceConsent | null;
  } | null>(null);
  const [updateSelection, setUpdateSelection] = useState<Record<string, string>>({});
  const [rollbackSelection, setRollbackSelection] = useState<Record<string, string>>({});

  const installedModuleIds = useMemo(
    () => new Set(modules.map((module) => module.module_id)),
    [modules],
  );
  const available = releases.filter((release) => !installedModuleIds.has(release.module_id));

  if (state === 'loading') {
    return (
      <main className="mx-auto flex min-h-80 max-w-6xl items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
        <Loading />
        Loading installed modules...
      </main>
    );
  }
  if (state === 'error') {
    return (
      <main className="mx-auto flex min-h-80 max-w-6xl flex-col items-center justify-center gap-4 px-4 py-8 text-sm">
        <p>{errorMessage(errorCode)}</p>
        <Button type="button" variant="outline" onClick={onReload}>
          Reload
        </Button>
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Project runtime
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Installed modules</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Exact releases, signatures, and reversible activation history.
          </p>
        </div>
        <Badge variant="outline">{modules.length} active</Badge>
      </header>

      <section aria-label="Installed modules" className="space-y-3">
        {modules.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PackageOpen />
              </EmptyMedia>
              <EmptyTitle>No modules installed</EmptyTitle>
              <EmptyDescription>
                Published declarative modules installed in this project will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Signature</TableHead>
                <TableHead className="w-72">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {modules.map((installation) => {
                const moduleReleases = releases.filter(
                  (release) => release.module_id === installation.module_id,
                );
                const updateTargets = moduleReleases.filter(
                  (release) => release.release_id !== installation.active_release_id,
                );
                const history = historyByInstallation[installation.installation_id] ?? [];
                const rollbackTargets = projectModuleRollbackTargets(
                  installation,
                  releases,
                  history,
                );
                const updateValue =
                  updateSelection[installation.module_id] ?? updateTargets[0]?.release_id;
                const rollbackValue =
                  rollbackSelection[installation.module_id] ?? rollbackTargets[0]?.release_id;
                const active = installation.status === 'active';
                const pending = pendingModuleId === installation.module_id;
                const activeRelease = moduleReleases.find(
                  (release) => release.release_id === installation.active_release_id,
                );
                const services = moduleServiceDeclarations(activeRelease?.manifest);
                const consents = serviceConsentsByInstallation[installation.installation_id] ?? [];
                return (
                  <TableRow key={installation.installation_id}>
                    <TableCell>
                      <p className="font-medium">
                        {moduleReleases.find(
                          (release) => release.release_id === installation.active_release_id,
                        )?.item_name ?? installation.module_id}
                      </p>
                      <p className="text-muted-foreground text-xs">{installation.module_id}</p>
                      {services.length > 0 ? (
                        <div className="mt-2 space-y-2" data-testid="module-service-access">
                          {services.map(({ service, operations }) => {
                            const consent =
                              consents.find(
                                (candidate) =>
                                  candidate.service === service &&
                                  candidate.release_id === installation.active_release_id &&
                                  candidate.install_revision === installation.install_revision,
                              ) ?? null;
                            const serviceKey = `${installation.installation_id}:${service}`;
                            const hasActiveConsent = consent?.revoked_at === null;
                            return (
                              <div key={service} className="border-l-2 border-border pl-2 text-xs">
                                <p className="font-medium">
                                  {service === 'ai' ? 'AI service' : 'Payment service'}
                                </p>
                                <p className="text-muted-foreground">{operations.join(', ')}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <Badge variant={hasActiveConsent ? 'secondary' : 'outline'}>
                                    {hasActiveConsent
                                      ? 'Granted'
                                      : consent
                                        ? 'Revoked'
                                        : 'Not granted'}
                                  </Badge>
                                  {canWrite && active ? (
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant="ghost"
                                      data-testid={`${hasActiveConsent ? 'revoke' : 'grant'}-service-${service}`}
                                      disabled={pendingServiceKey === serviceKey}
                                      onClick={() =>
                                        setServiceConsentTarget({
                                          installation,
                                          service,
                                          operations,
                                          consent,
                                        })
                                      }
                                    >
                                      {hasActiveConsent ? 'Revoke' : 'Grant access'}
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>{installation.active_version}</TableCell>
                    <TableCell>
                      <Badge variant={active ? 'secondary' : 'destructive'}>
                        {active ? 'Active' : 'Blocked'}
                      </Badge>
                      {!active ? (
                        <p className="text-muted-foreground mt-1 text-xs">
                          The active release was revoked.
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <ShieldCheck />
                        Verified
                        {moduleReleases.find(
                          (release) => release.release_id === installation.active_release_id,
                        )?.signature_key_id
                          ? ` / ${moduleReleases.find((release) => release.release_id === installation.active_release_id)?.signature_key_id}`
                          : ''}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          data-testid="history-module"
                          onClick={() => setHistoryInstallationId(installation.installation_id)}
                        >
                          <History />
                          Installation history
                        </Button>
                        {canWrite && active && updateTargets.length > 0 ? (
                          <>
                            <div className="flex flex-col gap-1">
                              <Select
                                value={updateValue}
                                onValueChange={(value) =>
                                  setUpdateSelection((current) => ({
                                    ...current,
                                    [installation.module_id]: value,
                                  }))
                                }
                              >
                                <SelectTrigger
                                  className="w-32"
                                  aria-label={`Update ${installation.module_id}`}
                                >
                                  <SelectValue placeholder="Version" />
                                </SelectTrigger>
                                <SelectContent>
                                  {updateTargets.map((release) => (
                                    <SelectItem key={release.release_id} value={release.release_id}>
                                      {release.module_version}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-muted-foreground text-xs">
                                Available update:{' '}
                                {updateTargets.map((release) => release.module_version).join(', ')}
                              </span>
                            </div>
                            <Button
                              type="button"
                              size="xs"
                              data-testid="update-module"
                              disabled={pending}
                              onClick={() => {
                                const release = updateTargets.find(
                                  (item) => item.release_id === updateValue,
                                );
                                if (release)
                                  setMoveTarget({
                                    kind: 'update',
                                    moduleId: installation.module_id,
                                    release,
                                    revision: installation.install_revision,
                                  });
                              }}
                            >
                              <Upload />
                              Update
                            </Button>
                          </>
                        ) : null}
                        {canWrite && active && rollbackTargets.length > 0 ? (
                          <>
                            <Select
                              value={rollbackValue}
                              onValueChange={(value) =>
                                setRollbackSelection((current) => ({
                                  ...current,
                                  [installation.module_id]: value,
                                }))
                              }
                            >
                              <SelectTrigger
                                className="w-32"
                                aria-label={`Rollback ${installation.module_id}`}
                              >
                                <SelectValue placeholder="History" />
                              </SelectTrigger>
                              <SelectContent>
                                {rollbackTargets.map((release) => (
                                  <SelectItem key={release.release_id} value={release.release_id}>
                                    {release.module_version}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              data-testid="rollback-module"
                              disabled={pending}
                              onClick={() => {
                                const release = rollbackTargets.find(
                                  (item) => item.release_id === rollbackValue,
                                );
                                if (release)
                                  setMoveTarget({
                                    kind: 'rollback',
                                    moduleId: installation.module_id,
                                    release,
                                    revision: installation.install_revision,
                                  });
                              }}
                            >
                              <RotateCcw />
                              Rollback
                            </Button>
                          </>
                        ) : null}
                        {!canWrite ? (
                          <span className="text-muted-foreground text-xs">Read-only</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {canWrite && available.length > 0 ? (
        <section aria-label="Available modules" className="space-y-3 border-t pt-6">
          <h2 className="text-base font-semibold">Available modules</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {available.map((release) => (
              <div
                key={release.release_id}
                className="flex items-center justify-between gap-3 border-b py-3"
              >
                <div>
                  <p className="font-medium">{release.item_name}</p>
                  <p className="text-muted-foreground text-xs">
                    {release.module_id} / {release.module_version}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  data-testid="install-module"
                  onClick={() => setInstallTarget(release)}
                >
                  <Upload />
                  Install
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Sheet
        open={historyInstallationId !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryInstallationId(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Installation history</SheetTitle>
            <SheetDescription>
              Only exact releases already recorded for this installation can be selected for
              rollback.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 flex flex-col gap-3">
            {(historyByInstallation[historyInstallationId ?? ''] ?? []).map((event) => (
              <div
                key={event.installation_event_id}
                className="border-l-2 border-border pl-3 text-sm"
              >
                <p className="font-medium">
                  {event.action} / {event.to_release_id}
                </p>
                <p className="text-muted-foreground text-xs">
                  Revision {event.resulting_revision} / {dateLabel(event.created_at)}
                </p>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {serviceConsentTarget ? (
        <ModuleServiceConsentDialog
          open
          service={serviceConsentTarget.service}
          operations={serviceConsentTarget.operations}
          consent={serviceConsentTarget.consent}
          pending={
            pendingServiceKey ===
            `${serviceConsentTarget.installation.installation_id}:${serviceConsentTarget.service}`
          }
          onOpenChange={(open) => {
            if (!open) setServiceConsentTarget(null);
          }}
          onGrant={() => {
            onGrantServiceConsent?.(
              serviceConsentTarget.installation,
              serviceConsentTarget.service,
              serviceConsentTarget.operations,
            );
            setServiceConsentTarget(null);
          }}
          onRevoke={() => {
            onRevokeServiceConsent?.(
              serviceConsentTarget.installation,
              serviceConsentTarget.service,
            );
            setServiceConsentTarget(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={installTarget !== null}
        onOpenChange={(open) => {
          if (!open) setInstallTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install exact release?</AlertDialogTitle>
            <AlertDialogDescription>
              {installTarget
                ? `${installTarget.item_name} ${installTarget.module_version} will be activated in this project.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (installTarget) onInstall(installTarget.release_id);
                setInstallTarget(null);
              }}
            >
              Install release
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {moveTarget?.kind === 'rollback'
                ? 'Rollback exact release?'
                : 'Update exact release?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {moveTarget
                ? `${moveTarget.release.item_name} ${moveTarget.release.module_version} will become the active release.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (moveTarget?.kind === 'rollback')
                  onRollback(
                    moveTarget.moduleId,
                    moveTarget.release.release_id,
                    moveTarget.revision,
                  );
                else if (moveTarget)
                  onUpdate(moveTarget.moduleId, moveTarget.release.release_id, moveTarget.revision);
                setMoveTarget(null);
              }}
            >
              {moveTarget?.kind === 'rollback' ? 'Rollback release' : 'Update release'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

export function ProjectModulesPage({ projectId }: { projectId: string }) {
  const canRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const modulesQuery = useProjectModules(projectId, canRead.allowed || canRead.isLoading);
  const releasesQuery = useProjectModuleReleases(canRead.allowed || canRead.isLoading);
  const installMutation = useInstallProjectModule();
  const updateMutation = useProjectModuleMutation('update');
  const rollbackMutation = useProjectModuleMutation('rollback');
  const grantServiceConsentMutation = useGrantProjectModuleServiceConsent();
  const revokeServiceConsentMutation = useRevokeProjectModuleServiceConsent();
  const [mutationHistoryByInstallation, setMutationHistoryByInstallation] = useState<
    Readonly<Record<string, readonly ProjectModuleInstallationEvent[]>>
  >({});
  const modules = modulesQuery.data ?? [];
  const releases = releasesQuery.data ?? [];
  const historyQueries = useProjectModuleHistories(
    projectId,
    modules,
    canRead.allowed || canRead.isLoading,
  );
  const serviceConsentQueries = useProjectModuleServiceConsentsForInstallations(
    projectId,
    modules,
    canRead.allowed || canRead.isLoading,
  );
  const serviceConsentsByInstallation = useMemo(() => {
    const next: Record<string, readonly ModuleServiceConsent[]> = {};
    modules.forEach((installation, index) => {
      next[installation.installation_id] = serviceConsentQueries[index]?.data ?? [];
    });
    return next;
  }, [modules, serviceConsentQueries]);
  const historyByInstallation = useMemo(() => {
    const next: Record<string, readonly ProjectModuleInstallationEvent[]> = {};
    modules.forEach((installation, index) => {
      const fetched = historyQueries[index]?.data ?? [];
      const local = mutationHistoryByInstallation[installation.installation_id] ?? [];
      const seen = new Set<string>();
      next[installation.installation_id] = [...fetched, ...local].filter((event) => {
        if (seen.has(event.installation_event_id)) return false;
        seen.add(event.installation_event_id);
        return true;
      });
    });
    return next;
  }, [historyQueries, modules, mutationHistoryByInstallation]);
  const queryError = modulesQuery.error ?? releasesQuery.error;
  const mutationError = installMutation.error ?? updateMutation.error ?? rollbackMutation.error;
  const errorCode =
    queryError || mutationError ? projectModuleErrorCode(queryError ?? mutationError) : null;
  const state: ProjectModulesPageState =
    canRead.isLoading || modulesQuery.isLoading || releasesQuery.isLoading
      ? 'loading'
      : !canRead.allowed || modulesQuery.isError || releasesQuery.isError
        ? 'error'
        : modules.length === 0
          ? 'empty'
          : 'ready';
  const pendingModuleId =
    updateMutation.variables?.moduleId ?? rollbackMutation.variables?.moduleId ?? null;
  const pendingServiceKey =
    grantServiceConsentMutation.isPending && grantServiceConsentMutation.variables
      ? `${grantServiceConsentMutation.variables.installationId}:${grantServiceConsentMutation.variables.service}`
      : null;
  const pendingRevokeServiceKey =
    revokeServiceConsentMutation.isPending && revokeServiceConsentMutation.variables
      ? `${revokeServiceConsentMutation.variables.installationId}:${revokeServiceConsentMutation.variables.service}`
      : null;
  const recordTransition = (transition: ProjectModuleInstallationTransition) =>
    setMutationHistoryByInstallation((current) => ({
      ...current,
      [transition.installation.installation_id]: [
        ...(current[transition.installation.installation_id] ?? []),
        transition.event,
      ],
    }));
  const key = (action: string, moduleId: string, releaseId: string, revision: number) =>
    `project-module:${projectId}:${action}:${moduleId}:${releaseId}:${revision}`;

  return (
    <ProjectModulesView
      state={state}
      modules={modules}
      releases={releases}
      historyByInstallation={historyByInstallation}
      canWrite={canWrite.allowed}
      pendingModuleId={pendingModuleId}
      errorCode={errorCode}
      serviceConsentsByInstallation={serviceConsentsByInstallation}
      pendingServiceKey={pendingServiceKey ?? pendingRevokeServiceKey ?? null}
      onInstall={(releaseId) =>
        installMutation.mutate(
          { projectId, releaseId, idempotencyKey: key('install', 'new', releaseId, 0) },
          { onSuccess: recordTransition },
        )
      }
      onUpdate={(moduleId, releaseId, revision) =>
        updateMutation.mutate(
          {
            projectId,
            moduleId,
            releaseId,
            expectedInstallRevision: revision,
            idempotencyKey: key('update', moduleId, releaseId, revision),
          },
          { onSuccess: recordTransition },
        )
      }
      onRollback={(moduleId, releaseId, revision) =>
        rollbackMutation.mutate(
          {
            projectId,
            moduleId,
            releaseId,
            expectedInstallRevision: revision,
            idempotencyKey: key('rollback', moduleId, releaseId, revision),
          },
          { onSuccess: recordTransition },
        )
      }
      onGrantServiceConsent={(installation, service, operations) =>
        grantServiceConsentMutation.mutate({
          projectId,
          installationId: installation.installation_id,
          service,
          operations: [...operations],
          expectedInstallRevision: installation.install_revision,
        })
      }
      onRevokeServiceConsent={(installation, service) =>
        revokeServiceConsentMutation.mutate({
          projectId,
          installationId: installation.installation_id,
          service,
          expectedInstallRevision: installation.install_revision,
        })
      }
      onReload={() => {
        void modulesQuery.refetch();
        void releasesQuery.refetch();
      }}
    />
  );
}
