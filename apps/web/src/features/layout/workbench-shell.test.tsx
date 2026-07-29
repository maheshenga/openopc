import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { WorkbenchShell } from './workbench-shell';

test('renders one primary rail, an optional contextual rail, and one stable main surface', () => {
  const html = renderToStaticMarkup(
    <WorkbenchShell
      destination="workspaces"
      contextualRail={<div data-testid="project-context">Project context</div>}
    >
      <section data-testid="workbench-content">Workspace content</section>
    </WorkbenchShell>,
  );

  expect((html.match(/data-workbench-primary-rail/g) ?? []).length).toBe(1);
  expect((html.match(/data-workbench-contextual-rail/g) ?? []).length).toBe(1);
  expect((html.match(/data-workbench-main/g) ?? []).length).toBe(1);
  expect(html).toContain('data-destination="workspaces"');
  expect(html).toContain('data-workbench-mobile-toggle');
  expect(html).toContain('data-openopc-search');
  expect(html).toContain('Workspace content');
});

test('omits the contextual rail without removing remote navigation', () => {
  const html = renderToStaticMarkup(
    <WorkbenchShell destination="account">
      <div>Account content</div>
    </WorkbenchShell>,
  );

  expect((html.match(/data-workbench-contextual-rail/g) ?? []).length).toBe(0);
  expect(html).toContain('data-destination="account"');
  expect(html).toContain('href="/accounts"');
  expect(html).not.toContain('full_access');
});
