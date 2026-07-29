'use client';

import type { ReactNode } from 'react';

import type { OpenOpcSearchResult } from '../search/openopc-search';
import { OpenOpcSearch } from '../search/openopc-search';

import { ContextualRail } from './contextual-rail';
import { PrimaryRail, type PrimaryDestination } from './primary-rail';

export interface WorkbenchShellProps {
  children: ReactNode;
  destination?: PrimaryDestination;
  contextualRail?: ReactNode;
  contextualTitle?: string;
  searchResults?: readonly OpenOpcSearchResult[];
}

export function WorkbenchShell({
  children,
  destination = 'workspaces',
  contextualRail,
  contextualTitle,
  searchResults,
}: WorkbenchShellProps) {
  return (
    <div
      data-workbench-shell
      data-destination={destination}
      className="bg-background flex min-h-svh min-w-0"
    >
      <PrimaryRail active={destination} />
      {contextualRail ? (
        <ContextualRail title={contextualTitle}>{contextualRail}</ContextualRail>
      ) : null}
      <main data-workbench-main className="min-w-0 flex-1">
        <div className="border-border bg-background/95 sticky top-0 z-20 flex min-h-14 items-center border-b px-4 py-2 backdrop-blur">
          <OpenOpcSearch results={searchResults} />
        </div>
        <div className="min-w-0">{children}</div>
      </main>
    </div>
  );
}
