import type { ReactNode } from 'react';

export interface ContextualRailProps {
  children: ReactNode;
  title?: string;
}

export function ContextualRail({ children, title = 'Context' }: ContextualRailProps) {
  return (
    <aside
      data-workbench-contextual-rail
      aria-label={title}
      className="border-border bg-muted/20 hidden w-64 shrink-0 border-r lg:flex lg:flex-col"
    >
      {children}
    </aside>
  );
}
