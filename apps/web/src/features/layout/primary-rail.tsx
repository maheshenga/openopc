'use client';

import {
  Blocks,
  Bot,
  Code2,
  FolderKanban,
  House,
  ListTodo,
  Menu,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

export type PrimaryDestination =
  'home' | 'workspaces' | 'agents' | 'tasks' | 'modules' | 'developer' | 'account';

export interface PrimaryRailItem {
  id: PrimaryDestination;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const PRIMARY_RAIL_ITEMS: readonly PrimaryRailItem[] = [
  { id: 'home', label: 'Home', href: '/projects', icon: House },
  { id: 'workspaces', label: 'Workspaces', href: '/projects', icon: FolderKanban },
  { id: 'agents', label: 'Agents', href: '/projects?view=agents', icon: Bot },
  { id: 'tasks', label: 'Tasks', href: '/projects?view=tasks', icon: ListTodo },
  { id: 'modules', label: 'Modules', href: '/developer/modules', icon: Blocks },
  { id: 'developer', label: 'Developer', href: '/developer/modules', icon: Code2 },
  { id: 'account', label: 'Account', href: '/accounts', icon: UserRound },
] as const;

function RailLinks({ active }: { active: PrimaryDestination }) {
  return (
    <div className="flex flex-col items-center gap-1">
      {PRIMARY_RAIL_ITEMS.map(({ id, label, href, icon: Icon }) => {
        const selected = active === id;
        return (
          <Link
            key={id}
            href={href}
            title={label}
            aria-label={label}
            data-destination={id}
            data-active={selected ? 'true' : 'false'}
            className={
              selected
                ? 'bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-lg shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground flex size-10 items-center justify-center rounded-lg transition-colors'
            }
          >
            <Icon className="size-4" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}

export function PrimaryRail({ active = 'workspaces' }: { active?: PrimaryDestination }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <aside
        data-workbench-primary-rail
        className="border-border bg-background/95 hidden w-14 shrink-0 flex-col items-center border-r py-3 md:flex"
      >
        <RailLinks active={active} />
      </aside>

      <div className="md:hidden">
        <button
          type="button"
          data-workbench-mobile-toggle
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setMobileOpen((open) => !open)}
          className="border-border bg-background/95 text-muted-foreground hover:text-foreground fixed top-3 left-3 z-50 flex size-9 items-center justify-center rounded-lg border shadow-sm"
        >
          {mobileOpen ? (
            <X className="size-4" aria-hidden="true" />
          ) : (
            <Menu className="size-4" aria-hidden="true" />
          )}
        </button>
        {mobileOpen && (
          <div
            data-workbench-mobile-drawer
            className="border-border bg-background fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r px-3 pt-16 shadow-xl"
          >
            <RailLinks active={active} />
          </div>
        )}
      </div>
    </>
  );
}
