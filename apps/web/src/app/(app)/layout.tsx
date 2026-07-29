'use client';

import { usePathname } from 'next/navigation';

import { WorkbenchShell } from '@/features/layout/workbench-shell';
import type { PrimaryDestination } from '@/features/layout/primary-rail';

function destinationForPathname(pathname: string | null): PrimaryDestination {
  if (pathname?.startsWith('/accounts')) return 'account';
  if (pathname?.startsWith('/developer')) return 'developer';
  if (pathname?.startsWith('/projects')) return 'workspaces';
  return 'home';
}

export default function AuthenticatedAppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <WorkbenchShell destination={destinationForPathname(pathname)}>{children}</WorkbenchShell>;
}
