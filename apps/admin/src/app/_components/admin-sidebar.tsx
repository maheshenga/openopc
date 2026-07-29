'use client';

import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Boxes,
  PackageCheck,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { AdminSidebarBrand } from './admin-sidebar-brand';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export function AdminSidebar() {
  const tDeveloperCenter = useTranslations('developerCenter');
  const pathname = usePathname();
  // Only pages that actually exist in this independent Admin application.
  const primaryItems: NavItem[] = [
    {
      href: '/ops',
      label: 'Operations',
      icon: Activity,
    },
    {
      href: '/utils',
      label: 'Maintenance',
      icon: Wrench,
    },
    {
      href: '/providers',
      label: 'Providers',
      icon: Boxes,
    },
    {
      href: '/accounts',
      label: 'Accounts',
      icon: Users,
    },
    {
      href: '/developer-reviews',
      label: tDeveloperCenter('admin.moduleReviews'),
      icon: PackageCheck,
    },
  ];

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="border-b border-sidebar-border/60">
        <Link
          href="/"
          className="flex items-center gap-2 px-2 py-1.5 transition-colors hover:text-foreground"
        >
          <AdminSidebarBrand />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryItems.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

    </Sidebar>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string | null }) {
  const active = isActive(pathname, item.href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link href={item.href}>
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function isActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
