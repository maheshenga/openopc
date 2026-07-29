import { ThemeToggle } from '@/components/home/theme-toggle';
import { Icon } from '@/features/icon/icon';
import { source } from '@/lib/source';
import { PRODUCT_BRAND } from '@kortix/product-brand';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';

import {
  DocsCollapsedControls,
  DocsSearchButton,
  DocsSearchIconButton,
  DocsSidebarCollapseButton,
  DocsSidebarSeparator,
} from './docs-controls';

// Fumadocs wraps `nav.title` in a link to `nav.url` ("/docs"), so this must NOT
// contain its own anchor — a nested <a> breaks hydration.
function DocsLogo() {
  return (
    <span className="ml-1 flex items-center gap-2.5 no-underline">
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded bg-neutral-950 font-mono text-[7px] font-bold tracking-[-0.08em] text-white dark:bg-white dark:text-neutral-950"
      >
        OPC
      </span>
      <span className="text-sm font-semibold tracking-tight">{PRODUCT_BRAND.displayName}</span>
    </span>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{
        enabled: false,
      }}
    >
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <DocsLogo />,
          url: '/docs',
          // Our own collapse trigger — `sidebar.collapsible: false` below
          // removes fumadocs' stock trigger + floating CollapsibleControl.
          children: <DocsSidebarCollapseButton />,
        }}
        searchToggle={{
          components: {
            lg: <DocsSearchButton />,
            sm: <DocsSearchIconButton />,
          },
        }}
        links={[
          {
            text: 'Home',
            url: '/',
          },
          {
            text: 'Changelog',
            url: '/changelog',
          },
          {
            type: 'icon',
            text: 'GitHub',
            label: 'GitHub',
            icon: <Icon.Github />,
            url: 'https://github.com/kortix-ai/suna',
            external: true,
          },
        ]}
        sidebar={{
          defaultOpenLevel: 1,
          // Collapse is still driven through useSidebar() by our own buttons
          // (docs-controls.tsx); false only strips fumadocs' built-in chrome.
          collapsible: false,
          components: {
            Separator: DocsSidebarSeparator,
          },
        }}
        themeSwitch={{
          // The app's own theme control (same one as the user menu) instead of
          // the fumadocs switch. The app-level next-themes provider still owns
          // persistence; RootProvider theme is disabled above.
          component: (
            <div className="ms-auto">
              <ThemeToggle variant="compact" />
            </div>
          ),
        }}
      >
        <DocsCollapsedControls />
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
