import { describe, expect, mock, test } from 'bun:test';
import type { IntelligenceStudioAsset } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import { AssetPreviewContent } from './asset-preview-dialog';
import {
  type AssetsPageLabels,
  AssetsPageView,
  createAssetDownloadController,
} from './assets-page';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_JOB_ID = '22222222-2222-4222-8222-222222222222';

const LABELS: AssetsPageLabels = {
  title: 'Project assets',
  description: 'Browse generated and uploaded images in this project.',
  formatFilter: 'Format',
  sourceFilter: 'Source',
  allFormats: 'All formats',
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  otherFormats: 'Other',
  allSources: 'All sources',
  generated: 'Generated',
  uploaded: 'Uploaded',
  loading: 'Loading assets',
  errorTitle: 'Assets could not be loaded',
  downloadError: 'Download could not be prepared',
  retry: 'Retry',
  emptyTitle: 'No assets yet',
  emptyDescription: 'Generated and uploaded images will appear here.',
  noMatchesTitle: 'No matching assets',
  noMatchesDescription: 'Change the filters to see more assets.',
  imageAsset: 'Image asset',
  unknownDimensions: 'Unknown dimensions',
  preview: 'Preview',
  download: 'Download',
  downloading: 'Preparing download',
  reuse: 'Reuse in Image Studio',
  sourceJob: 'Open source job',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  page: 'Page 2',
  previewTitle: 'Asset preview',
  previewDescription: 'Short-lived preview for this project asset.',
  previewLoading: 'Preparing preview',
  previewErrorTitle: 'Preview unavailable',
  close: 'Close',
};

const GENERATED_ASSET: IntelligenceStudioAsset = {
  asset_id: '33333333-3333-4333-8333-333333333333',
  account_id: '44444444-4444-4444-8444-444444444444',
  project_id: PROJECT_ID,
  source_job_id: SOURCE_JOB_ID,
  kind: 'image',
  mime_type: 'image/png',
  bucket: 'studio-assets',
  object_key: 'generated/first.png',
  checksum_sha256: 'a'.repeat(64),
  size_bytes: 1_048_576,
  width: 1024,
  height: 1024,
  metadata: {},
  created_at: '2026-07-20T08:00:00.000Z',
};
const UPLOADED_ASSET: IntelligenceStudioAsset = {
  asset_id: '55555555-5555-4555-8555-555555555555',
  account_id: '44444444-4444-4444-8444-444444444444',
  project_id: PROJECT_ID,
  source_job_id: null,
  kind: 'image',
  mime_type: 'image/jpeg',
  bucket: 'studio-assets',
  object_key: 'uploads/second.jpg',
  checksum_sha256: 'b'.repeat(64),
  size_bytes: 524_288,
  width: 1600,
  height: 900,
  metadata: {},
  created_at: '2026-07-20T09:00:00.000Z',
};
const OTHER_ASSET: IntelligenceStudioAsset = {
  asset_id: '66666666-6666-4666-8666-666666666666',
  account_id: '44444444-4444-4444-8444-444444444444',
  project_id: PROJECT_ID,
  source_job_id: null,
  kind: 'image',
  mime_type: 'image/gif',
  bucket: 'studio-assets',
  object_key: 'uploads/third.gif',
  checksum_sha256: 'c'.repeat(64),
  size_bytes: 256,
  width: null,
  height: null,
  metadata: {},
  created_at: '2026-07-20T10:00:00.000Z',
};
const ASSETS: IntelligenceStudioAsset[] = [GENERATED_ASSET, UPLOADED_ASSET, OTHER_ASSET];

function renderAssets(
  overrides: Partial<React.ComponentProps<typeof AssetsPageView>> = {},
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AssetsPageView
        projectId={PROJECT_ID}
        assets={ASSETS}
        loading={false}
        error={null}
        mimeFilter="all"
        sourceFilter="all"
        nextCursor={null}
        hasPreviousPage={false}
        downloadingAssetId={null}
        labels={LABELS}
        onMimeFilterChange={() => undefined}
        onSourceFilterChange={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
        onRetry={() => undefined}
        onNextPage={() => undefined}
        onPreviousPage={() => undefined}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

describe('AssetsPageView', () => {
  test('renders stable loading, error, and empty states', () => {
    const loadingHtml = renderAssets({ assets: [], loading: true });
    expect(loadingHtml).toContain('aria-label="Loading assets"');
    expect(loadingHtml).toContain('aspect-square');

    const errorHtml = renderAssets({ assets: [], error: 'Request failed' });
    expect(errorHtml).toContain('Assets could not be loaded');
    expect(errorHtml).toContain('Request failed');
    expect(errorHtml).toContain('Retry');

    const emptyHtml = renderAssets({ assets: [] });
    expect(emptyHtml).toContain('No assets yet');
    expect(emptyHtml).toContain('Generated and uploaded images will appear here.');
  });

  test('filters by MIME family and source without changing grid dimensions', () => {
    const html = renderAssets({ mimeFilter: 'png', sourceFilter: 'generated' });

    expect(html).toContain(`data-asset-id="${GENERATED_ASSET.asset_id}"`);
    expect(html).not.toContain(`data-asset-id="${UPLOADED_ASSET.asset_id}"`);
    expect(html).not.toContain(`data-asset-id="${OTHER_ASSET.asset_id}"`);
    expect(html).toContain('aria-label="Format"');
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('aspect-square');
    expect(html).toContain('grid-cols-1');

    const noMatchHtml = renderAssets({ mimeFilter: 'webp', sourceFilter: 'uploaded' });
    expect(noMatchHtml).toContain('No matching assets');
  });

  test('renders cursor pagination and project-scoped source and reuse links', () => {
    const html = renderAssets({
      nextCursor: 'next-page-cursor',
      hasPreviousPage: true,
    });

    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-label="Next page"');
    expect(html).toContain('Page 2');
    expect(html).toContain(`href="/projects/${PROJECT_ID}/studio/image?job=${SOURCE_JOB_ID}"`);
    expect(html).toContain(
      `href="/projects/${PROJECT_ID}/studio/image?reference=${GENERATED_ASSET.asset_id}"`,
    );
    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('aria-label="Download"');
  });
});

describe('AssetPreviewContent', () => {
  test('renders only the short-lived URL supplied in memory', () => {
    const signedUrl = 'https://assets.example.test/signed-preview';
    const html = renderToStaticMarkup(
      <AssetPreviewContent
        asset={GENERATED_ASSET}
        previewUrl={signedUrl}
        loading={false}
        error={null}
        labels={LABELS}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain(`src="${signedUrl}"`);
    expect(html).toContain('alt="Image asset"');
    expect(html).toContain('aspect-square');
  });
});

describe('createAssetDownloadController', () => {
  test('normalizes raw asset errors to stable non-secret codes', async () => {
    const assetsModule = (await import('./assets-page')) as {
      studioAssetsErrorCode?: (error: unknown) => string;
    };

    expect(assetsModule.studioAssetsErrorCode).toBeFunction();
    expect(
      assetsModule.studioAssetsErrorCode?.(
        new Error('GET https://assets.example.test/file?signature=secret failed'),
      ),
    ).toBe('STUDIO_ASSETS_REQUEST_FAILED');
    expect(assetsModule.studioAssetsErrorCode?.({ code: 'STUDIO_ASSET_NOT_FOUND' })).toBe(
      'STUDIO_ASSET_NOT_FOUND',
    );
  });

  test('does not request or retain a signed URL until download is invoked', async () => {
    const createDownloadUrl = mock(async (assetId: string) => ({
      asset_id: assetId,
      signed_download_url: 'https://assets.example.test/signed-download',
      expires_at: '2026-07-20T11:00:00.000Z',
    }));
    const openUrl = mock((_url: string) => undefined);
    const controller = createAssetDownloadController({ createDownloadUrl, openUrl });

    expect(createDownloadUrl).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();

    await controller.download(GENERATED_ASSET.asset_id);

    expect(createDownloadUrl).toHaveBeenCalledTimes(1);
    expect(createDownloadUrl).toHaveBeenCalledWith(GENERATED_ASSET.asset_id);
    expect(openUrl).toHaveBeenCalledWith('https://assets.example.test/signed-download');
  });
});
