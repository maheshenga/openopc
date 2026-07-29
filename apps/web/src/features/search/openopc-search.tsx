'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PageSearchBar } from '@/components/ui/page-search-bar';
import { cn } from '@/lib/utils';

export type OpenOpcSearchKind = 'task' | 'agent' | 'module' | 'project' | 'file';

export interface OpenOpcSearchResult {
  kind: OpenOpcSearchKind;
  id: string;
  title: string;
  href: string;
}

export interface OpenOpcSearchGroup {
  kind: OpenOpcSearchKind;
  label: string;
  items: OpenOpcSearchResult[];
}

export const OPENOPC_SEARCH_KIND_ORDER: readonly OpenOpcSearchKind[] = [
  'task',
  'agent',
  'module',
  'project',
  'file',
] as const;

const SEARCH_KIND_LABELS: Record<OpenOpcSearchKind, string> = {
  task: 'Tasks',
  agent: 'Agents',
  module: 'Modules',
  project: 'Projects',
  file: 'Files',
};

export function groupOpenOpcSearchResults(
  results: readonly OpenOpcSearchResult[],
  query = '',
): OpenOpcSearchGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return OPENOPC_SEARCH_KIND_ORDER.flatMap((kind) => {
    const items = results.filter((result) => {
      if (result.kind !== kind) return false;
      if (!normalizedQuery) return true;
      return `${result.title} ${result.id}`.toLocaleLowerCase().includes(normalizedQuery);
    });
    return items.length > 0 ? [{ kind, label: SEARCH_KIND_LABELS[kind], items }] : [];
  });
}

export interface OpenOpcSearchProps {
  results?: readonly OpenOpcSearchResult[];
  onSelect?: (result: OpenOpcSearchResult) => void;
  className?: string;
  placeholder?: string;
}

export function OpenOpcSearch({
  results = [],
  onSelect,
  className,
  placeholder = 'Search tasks, agents, modules, projects, or files',
}: OpenOpcSearchProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupOpenOpcSearchResults(results, query), [results, query]);

  return (
    <div data-openopc-search className={cn('w-full max-w-xl', className)}>
      <PageSearchBar value={query} onChange={setQuery} placeholder={placeholder} />
      {query.trim() && (
        <div className="border-border bg-background mt-2 max-h-80 overflow-y-auto rounded-lg border p-1 shadow-lg">
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">No matches</p>
          ) : (
            groups.map((group) => (
              <section key={group.kind} data-search-group={group.kind} className="py-1">
                <h2 className="text-muted-foreground px-3 py-1 text-[11px] font-medium tracking-wide uppercase">
                  {group.label}
                </h2>
                {group.items.map((result) => (
                  <Link
                    key={`${result.kind}:${result.id}`}
                    href={result.href}
                    data-search-kind={result.kind}
                    onClick={() => onSelect?.(result)}
                    className="hover:bg-muted flex items-center rounded-md px-3 py-2 text-sm"
                  >
                    {result.title}
                  </Link>
                ))}
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
