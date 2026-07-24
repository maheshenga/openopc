'use client';

import { PackageOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

export interface ProjectModulesNavLabels {
  label: string;
  linkLabel: string;
}

export function ProjectModulesNavView({
  projectId,
  pathname,
  labels,
  onNavigate,
  visible = true,
}: {
  projectId: string;
  pathname: string | null;
  labels: ProjectModulesNavLabels;
  onNavigate: () => void;
  visible?: boolean;
}) {
  if (!visible) return null;
  const href = `/projects/${projectId}/modules`;
  const active = pathname === href || pathname?.startsWith(`${href}/`) === true;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={labels.label}
        className="text-sm! font-medium [&_svg]:size-4!"
      >
        <Link
          href={href}
          onClick={onNavigate}
          aria-label={labels.linkLabel}
          aria-current={active ? 'page' : undefined}
        >
          <PackageOpen />
          <span>{labels.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ProjectModulesNavItem({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const permission = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ);
  const onNavigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  return (
    <ProjectModulesNavView
      projectId={projectId}
      pathname={pathname}
      labels={{ label: 'Installed modules', linkLabel: 'Open installed modules' }}
      onNavigate={onNavigate}
      visible={permission.allowed || permission.isLoading}
    />
  );
}
