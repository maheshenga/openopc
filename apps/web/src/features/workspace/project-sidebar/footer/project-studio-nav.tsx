'use client';

import { useIntelligenceCapabilityDiscovery } from '@kortix/sdk/react';
import { Image as ImageIcon, Images } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import {
  type StudioImageExecutionTarget,
  hasExecutableImageTarget,
} from '@/features/studio/studio-shell';
import { useIsMobile } from '@/hooks/utils';

export interface ProjectStudioNavLabels {
  imageStudio: string;
  assets: string;
  imageStudioLink: string;
  assetsLink: string;
}

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || pathname?.startsWith(`${href}/`) === true;
}

export function ProjectStudioNavView({
  projectId,
  pathname,
  targets,
  labels,
  onNavigate,
}: {
  projectId: string;
  pathname: string | null;
  targets: readonly StudioImageExecutionTarget[];
  labels: ProjectStudioNavLabels;
  onNavigate: () => void;
}) {
  if (!hasExecutableImageTarget(targets)) return null;

  const imageHref = `/projects/${projectId}/studio/image`;
  const assetsHref = `/projects/${projectId}/studio/assets`;
  const imageActive = isActive(pathname, imageHref);
  const assetsActive = isActive(pathname, assetsHref);

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={imageActive}
          tooltip={labels.imageStudio}
          className="text-sm! font-medium [&_svg]:size-4!"
        >
          <Link
            href={imageHref}
            onClick={onNavigate}
            aria-label={labels.imageStudioLink}
            aria-current={imageActive ? 'page' : undefined}
          >
            <ImageIcon />
            <span>{labels.imageStudio}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={assetsActive}
          tooltip={labels.assets}
          className="text-sm! font-medium [&_svg]:size-4!"
        >
          <Link
            href={assetsHref}
            onClick={onNavigate}
            aria-label={labels.assetsLink}
            aria-current={assetsActive ? 'page' : undefined}
          >
            <Images />
            <span>{labels.assets}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  );
}

export function ProjectStudioNavItem({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const t = useTranslations('studio');
  const discovery = useIntelligenceCapabilityDiscovery(projectId);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <ProjectStudioNavView
      projectId={projectId}
      pathname={pathname}
      targets={discovery.data?.execution_targets ?? []}
      labels={{
        imageStudio: t('imageStudio'),
        assets: t('assets'),
        imageStudioLink: t('imageStudioLink'),
        assetsLink: t('assetsLink'),
      }}
      onNavigate={closeMobileSidebar}
    />
  );
}
