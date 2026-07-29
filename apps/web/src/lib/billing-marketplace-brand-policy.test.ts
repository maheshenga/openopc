import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

test('billing, support, and marketplace surfaces use OpenOPC brand constants while retaining internal image paths', () => {
  const noInstance = source('src/components/dashboard/no-instance-state.tsx');
  const newInstance = source('src/features/billing/pricing/new-instance-modal.tsx');
  const errorHandler = source('src/lib/error-handler.tsx');
  const companyFilter = source('src/features/marketplace/marketplace-company-filter.tsx');
  const addMarketplace = source('src/features/marketplace/add-marketplace-modal.tsx');

  expect(noInstance).toContain('alt={PRODUCT_BRAND.localNodeName}');
  expect(newInstance).toContain('alt={PRODUCT_BRAND.localNodeName}');
  expect(newInstance).toContain('`${PRODUCT_BRAND.localNodeName} is on its way`');
  expect(newInstance).toContain('title || `Your ${PRODUCT_BRAND.localNodeName}`');
  expect(errorHandler).toContain('contact the ${PRODUCT_BRAND.displayName} team');
  expect(companyFilter).toContain('kortix: PRODUCT_BRAND.displayName');
  expect(addMarketplace).toContain('Point {PRODUCT_BRAND.displayName} at any git repo');

  const visibleSources = [
    noInstance,
    newInstance,
    errorHandler,
    companyFilter,
    addMarketplace,
  ].join('\n');
  for (const legacyCopy of [
    'alt="Kortix Computer"',
    "'Your Kortix is on its way'",
    "title || 'Your Kortix'",
    'contact the Kortix team',
    "kortix: 'Kortix'",
    'Point Kortix at any git repo',
  ]) {
    expect(visibleSources).not.toContain(legacyCopy);
  }

  expect(noInstance).toContain('src="/kortix-computer.png"');
  expect(newInstance).toContain('src="/kortix-computer.png"');
});
