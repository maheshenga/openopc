'use client';

import type { ProjectModuleLaunchDescriptor } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { type RefCallback, useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';

import {
  type PublishedProjectModuleRelease,
  getProjectModuleLaunchDescriptor,
  issueProjectModuleServiceCapability,
} from './client';
import { attachProjectModuleHostBridge } from './project-module-host';
import {
  type ProjectModuleUiErrorCode,
  projectModuleErrorCode,
  projectModuleLaunchQuery,
  projectModuleReleaseQuery,
} from './query';

export type ProjectModuleHostState = 'loading' | 'error' | 'ready';

export interface ProjectModuleHostViewProps {
  state: ProjectModuleHostState;
  projectId: string;
  descriptor: ProjectModuleLaunchDescriptor | null;
  release: PublishedProjectModuleRelease | null;
  errorCode: ProjectModuleUiErrorCode | null;
  iframeRef?: RefCallback<HTMLIFrameElement>;
  onReload: () => void;
}

const UNAVAILABLE_COPY: Partial<Record<ProjectModuleUiErrorCode, string>> = {
  PROJECT_MODULE_INACTIVE: 'This module is no longer active.',
  PROJECT_MODULE_NOT_LAUNCHABLE: 'This module does not provide a sandboxed Web experience.',
  PROJECT_MODULE_LAUNCH_STALE:
    'This module changed while it was opening. Reload to use the current release.',
  PROJECT_MODULE_HOST_UNAVAILABLE: 'The module host is unavailable. Try again shortly.',
  OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE:
    'This module cannot run with the current platform capability profile.',
};

function unavailableCopy(errorCode: ProjectModuleUiErrorCode | null): string {
  return (
    (errorCode ? UNAVAILABLE_COPY[errorCode] : undefined) ??
    'This module could not be opened. Reload to try again.'
  );
}

function HostActions({ projectId, onReload }: { projectId: string; onReload: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button asChild variant="ghost" className="min-h-10">
        <Link href={`/projects/${projectId}/modules`}>
          <ArrowLeft className="size-4 shrink-0" />
          Installed modules
        </Link>
      </Button>
      <Button type="button" variant="outline" className="min-h-10" onClick={onReload}>
        <RefreshCw className="size-4 shrink-0" />
        Reload module
      </Button>
    </div>
  );
}

export function ProjectModuleHostView({
  state,
  projectId,
  descriptor,
  release,
  errorCode,
  iframeRef,
  onReload,
}: ProjectModuleHostViewProps) {
  if (state === 'loading') {
    return (
      <main className="flex h-full min-h-0 items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
        <Loading />
        Loading module...
      </main>
    );
  }

  if (state === 'error' || !descriptor || !release) {
    return (
      <main className="flex h-full min-h-0 flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="space-y-1">
          <h1 className="text-xl font-medium text-balance">Module unavailable</h1>
          <p className="text-muted-foreground max-w-lg text-sm text-pretty">
            {unavailableCopy(errorCode)}
          </p>
        </div>
        <HostActions projectId={projectId} onReload={onReload} />
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" className="min-h-10 shrink-0">
            <Link href={`/projects/${projectId}/modules`}>
              <ArrowLeft className="size-4 shrink-0" />
              Installed modules
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium text-balance">{release.item_name}</h1>
            <p className="text-muted-foreground truncate text-xs">{descriptor.module_id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">
            {descriptor.module_version}
          </Badge>
          <Button type="button" size="sm" variant="outline" className="min-h-10" onClick={onReload}>
            <RefreshCw className="size-3.5 shrink-0" />
            Reload module
          </Button>
        </div>
      </header>
      <iframe
        key={`${descriptor.release_id}:${descriptor.install_revision}`}
        ref={iframeRef}
        src={descriptor.url}
        title={`${release.item_name} module`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </main>
  );
}

function releaseMatchesDescriptor(
  release: PublishedProjectModuleRelease | null,
  descriptor: ProjectModuleLaunchDescriptor | null,
): release is PublishedProjectModuleRelease {
  return Boolean(
    release &&
      descriptor &&
      release.release_id === descriptor.release_id &&
      release.module_id === descriptor.module_id &&
      release.module_version === descriptor.module_version,
  );
}

export function ProjectModuleHostPage({
  projectId,
  installationId,
}: {
  projectId: string;
  installationId: string;
}) {
  const launchQuery = useQuery(projectModuleLaunchQuery(projectId, installationId));
  const descriptor = launchQuery.data ?? null;
  const releaseQuery = useQuery({
    ...projectModuleReleaseQuery(descriptor?.release_id ?? ''),
    enabled: descriptor !== null,
  });
  const release = releaseQuery.data ?? null;
  const matches = releaseMatchesDescriptor(release, descriptor);
  const queryError = launchQuery.error ?? releaseQuery.error;
  const errorCode = queryError
    ? projectModuleErrorCode(queryError)
    : descriptor && release && !matches
      ? 'PROJECT_MODULE_LAUNCH_STALE'
      : null;
  const state: ProjectModuleHostState =
    launchQuery.isLoading || (descriptor !== null && releaseQuery.isLoading)
      ? 'loading'
      : errorCode
        ? 'error'
        : matches
          ? 'ready'
          : 'loading';
  const [moduleSource, setModuleSource] = useState<Window | null>(null);
  const iframeRef = useCallback<RefCallback<HTMLIFrameElement>>(
    (iframe) => setModuleSource(iframe?.contentWindow ?? null),
    [],
  );

  useEffect(() => {
    if (!moduleSource || state !== 'ready' || !descriptor || !matches) return undefined;
    return attachProjectModuleHostBridge({
      eventTarget: window,
      moduleSource,
      projectId,
      descriptor,
      manifest: release.manifest,
      issueCapability: issueProjectModuleServiceCapability,
      resolveLaunch: () => getProjectModuleLaunchDescriptor(projectId, installationId),
    });
  }, [descriptor, installationId, matches, moduleSource, projectId, release, state]);

  return (
    <ProjectModuleHostView
      state={state}
      projectId={projectId}
      descriptor={descriptor}
      release={matches ? release : null}
      errorCode={errorCode}
      iframeRef={iframeRef}
      onReload={() => {
        void launchQuery.refetch();
        if (descriptor) void releaseQuery.refetch();
      }}
    />
  );
}
