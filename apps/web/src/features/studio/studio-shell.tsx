'use client';

import { useIntelligenceCapabilityDiscovery } from '@kortix/sdk/react';
import { Image as ImageIcon, ImageOff, Images } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';

export interface StudioImageExecutionTarget {
  capability_id: string;
}

export interface StudioShellLabels {
  imageStudio: string;
  assets: string;
  loading: string;
  unavailable: string;
  navigation: string;
  imageStudioLink: string;
  assetsLink: string;
}

export function hasExecutableImageTarget(targets: readonly StudioImageExecutionTarget[]): boolean {
  return targets.some((target) => target.capability_id === 'studio.image.generate');
}

function isStudioRouteActive(pathname: string | null, href: string): boolean {
  return pathname === href || pathname?.startsWith(`${href}/`) === true;
}

export function StudioShellView({
  projectId,
  pathname,
  targets,
  loading,
  failed,
  labels,
  children,
}: {
  projectId: string;
  pathname: string | null;
  targets: readonly StudioImageExecutionTarget[];
  loading: boolean;
  failed: boolean;
  labels: StudioShellLabels;
  children: React.ReactNode;
}) {
  const available = hasExecutableImageTarget(targets);
  const imageHref = `/projects/${projectId}/studio/image`;
  const assetsHref = `/projects/${projectId}/studio/assets`;

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="border-border flex h-11 shrink-0 items-center border-b pr-3 pl-12 md:pl-3">
        {available && !loading ? (
          <nav aria-label={labels.navigation} className="flex min-w-0 items-center gap-1">
            <Link
              href={imageHref}
              className={cn(
                'text-muted-foreground hover:bg-primary/[0.05] hover:text-foreground flex h-10 items-center gap-2 rounded-md px-2.5 text-sm font-medium transition-[color,background-color,transform] active:scale-[0.96]',
                isStudioRouteActive(pathname, imageHref) && 'bg-primary/[0.08] text-foreground',
              )}
              aria-label={labels.imageStudioLink}
              aria-current={isStudioRouteActive(pathname, imageHref) ? 'page' : undefined}
            >
              <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
              <span>{labels.imageStudio}</span>
            </Link>
            <Link
              href={assetsHref}
              className={cn(
                'text-muted-foreground hover:bg-primary/[0.05] hover:text-foreground flex h-10 items-center gap-2 rounded-md px-2.5 text-sm font-medium transition-[color,background-color,transform] active:scale-[0.96]',
                isStudioRouteActive(pathname, assetsHref) && 'bg-primary/[0.08] text-foreground',
              )}
              aria-label={labels.assetsLink}
              aria-current={isStudioRouteActive(pathname, assetsHref) ? 'page' : undefined}
            >
              <Images className="size-4 shrink-0" aria-hidden="true" />
              <span>{labels.assets}</span>
            </Link>
          </nav>
        ) : null}
      </header>

      {loading ? (
        <output className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-sm">
          <Loading className="size-4 shrink-0" />
          <span>{labels.loading}</span>
        </output>
      ) : available || failed ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      ) : (
        <output className="min-h-0 flex-1">
          <EmptyState icon={ImageOff} title={labels.unavailable} size="sm" className="h-full" />
        </output>
      )}
    </div>
  );
}

export function StudioShell({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useTranslations('studio');
  const discovery = useIntelligenceCapabilityDiscovery(projectId);

  return (
    <StudioShellView
      projectId={projectId}
      pathname={pathname}
      targets={discovery.data?.execution_targets ?? []}
      loading={discovery.isLoading}
      failed={discovery.isError}
      labels={{
        imageStudio: t('imageStudio'),
        assets: t('assets'),
        loading: t('loading'),
        unavailable: t('unavailable'),
        navigation: t('navigation'),
        imageStudioLink: t('imageStudioLink'),
        assetsLink: t('assetsLink'),
      }}
    >
      {children}
    </StudioShellView>
  );
}
