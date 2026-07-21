import { expect, test } from 'bun:test';
import { CORS_ALLOW_HEADERS } from '../lib/cors-policy';

test('CORS allows AG-UI Last-Event-ID resume requests', () => {
  expect(CORS_ALLOW_HEADERS.map((header) => header.toLowerCase())).toContain('last-event-id');
});
