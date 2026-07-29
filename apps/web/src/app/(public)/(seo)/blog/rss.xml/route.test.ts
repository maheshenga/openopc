import { expect, test } from 'bun:test';

import { GET } from './route';

test('publishes the RSS channel under the OpenOPC visible brand', async () => {
  const response = GET();
  const xml = await response.text();

  expect(response.headers.get('content-type')).toContain('application/rss+xml');
  expect(xml).toContain('<title>OpenOPC Blog</title>');
});
