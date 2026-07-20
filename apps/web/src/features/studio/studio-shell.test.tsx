import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { type StudioShellLabels, StudioShellView } from './studio-shell';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TARGETS = [
  {
    capability_id: 'studio.image.generate' as const,
    provider_config_id: '22222222-2222-4222-8222-222222222222',
    model: 'image-model',
  },
];
const LABELS: StudioShellLabels = {
  imageStudio: 'Image Studio',
  assets: 'Assets',
  loading: 'Loading Studio...',
  unavailable: 'Image generation is unavailable for this project.',
  navigation: 'Studio navigation',
  imageStudioLink: 'Open Image Studio',
  assetsLink: 'Open project assets',
};

function renderShell({
  pathname = `/projects/${PROJECT_ID}/studio/image`,
  targets = TARGETS,
  loading = false,
  failed = false,
}: {
  pathname?: string;
  targets?: typeof TARGETS | [];
  loading?: boolean;
  failed?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <StudioShellView
      projectId={PROJECT_ID}
      pathname={pathname}
      targets={targets}
      loading={loading}
      failed={failed}
      labels={LABELS}
    >
      <main>Studio work surface</main>
    </StudioShellView>,
  );
}

describe('StudioShellView', () => {
  test('renders only the retained Image Studio and Assets destinations', () => {
    const html = renderShell();

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

  test('marks the current Studio destination and keeps the work surface mounted', () => {
    const html = renderShell({ pathname: `/projects/${PROJECT_ID}/studio/assets` });

    expect(html).toContain('aria-label="Open project assets" aria-current="page"');
    expect(html).toContain('Studio work surface');
  });

  test('shows a bounded unavailable state when no image target can execute', () => {
    const html = renderShell({ targets: [] });

    expect(html).toContain('Image generation is unavailable for this project.');
    expect(html).not.toContain('Studio work surface');
    expect(html).not.toContain(`/projects/${PROJECT_ID}/studio/image`);
  });

  test('shows loading copy without exposing the work surface', () => {
    const html = renderShell({ loading: true, targets: [] });

    expect(html).toContain('Loading Studio...');
    expect(html).not.toContain('Studio work surface');
  });

  test('keeps the work surface mounted when discovery fails so its retry UI can render', () => {
    const html = renderShell({ failed: true, targets: [] });

    expect(html).toContain('Studio work surface');
    expect(html).not.toContain('Image generation is unavailable for this project.');
  });
});
