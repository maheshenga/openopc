import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarProvider } from '@/components/ui/sidebar';
import { type ProjectStudioNavLabels, ProjectStudioNavView } from './project-studio-nav';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TARGETS = [
  {
    capability_id: 'studio.image.generate' as const,
    provider_config_id: '22222222-2222-4222-8222-222222222222',
    model: 'image-model',
  },
];
const LABELS: ProjectStudioNavLabels = {
  imageStudio: 'Image Studio',
  assets: 'Assets',
  imageStudioLink: 'Open Image Studio',
  assetsLink: 'Open project assets',
};

function renderProjectStudioNav({
  pathname = `/projects/${PROJECT_ID}/studio/image`,
  targets = TARGETS,
}: {
  pathname?: string;
  targets?: typeof TARGETS | [];
} = {}) {
  return renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <ProjectStudioNavView
        projectId={PROJECT_ID}
        pathname={pathname}
        targets={targets}
        labels={LABELS}
        onNavigate={() => {}}
      />
    </SidebarProvider>,
  );
}

describe('ProjectStudioNavView', () => {
  test('renders only Image Studio and Assets for an executable image target', () => {
    const html = renderProjectStudioNav();

    expect(html).toContain(`href="/projects/${PROJECT_ID}/studio/image"`);
    expect(html).toContain(`href="/projects/${PROJECT_ID}/studio/assets"`);
    expect(html).toContain('Image Studio');
    expect(html).toContain('Assets');
    expect(html).not.toContain('/studio/video');
    expect(html).not.toContain('/studio/voice');
    expect(html).not.toContain('/studio/3d');
    expect(html).not.toContain('/studio/digital-human');
    expect(html).not.toContain('/studio/batch-remix');
  });

  test('marks the active project Studio route', () => {
    const html = renderProjectStudioNav({
      pathname: `/projects/${PROJECT_ID}/studio/assets`,
    });

    expect(html).toContain('aria-label="Open project assets" aria-current="page"');
    expect(html).toContain('data-active="true"');
  });

  test('does not render a disabled Studio placeholder', () => {
    const html = renderProjectStudioNav({ targets: [] });

    expect(html).not.toContain('Image Studio');
    expect(html).not.toContain('Assets');
    expect(html).not.toContain('/studio/video');
    expect(html).not.toContain('sidebar-menu-item');
  });
});
