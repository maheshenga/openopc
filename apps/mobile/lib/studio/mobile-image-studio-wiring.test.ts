import { describe, expect, test } from 'bun:test';

const mobileRoot = `${import.meta.dir}/../..`;

describe('mobile Image Studio wiring', () => {
  test('uses the shared SDK from route to page without host-local fetch', async () => {
    const route = await Bun.file(`${mobileRoot}/app/projects/[id]/studio.tsx`).text();
    const page = await Bun.file(`${mobileRoot}/components/studio/MobileImageStudioPage.tsx`).text();
    const view = await Bun.file(`${mobileRoot}/components/studio/MobileImageStudioView.tsx`).text();
    const drawer = await Bun.file(`${mobileRoot}/components/session/RightDrawerContent.tsx`).text();

    expect(route).toContain('<MobileImageStudioPage');
    expect(page).toContain("from '@kortix/sdk/react'");
    expect(page).toContain('<MobileImageStudioView');
    expect(page).toContain('useIntelligenceTaskEvents');
    expect(page).toContain('useIntelligenceAssets');
    expect(page).toContain('AppState.addEventListener');
    expect(page).not.toMatch(/\bfetch\s*\(/);
    expect(view).not.toMatch(/\bfetch\s*\(/);
    expect(drawer).toContain('useIntelligenceCapabilityDiscovery');
    expect(drawer).toContain('hasMobileImageTarget');
    expect(drawer).toContain('/projects/${projectId}/studio');
  });
});
