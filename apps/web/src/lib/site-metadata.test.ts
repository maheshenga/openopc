import { describe, expect, test } from 'bun:test';

import { siteMetadata } from './site-metadata';

describe('public product metadata', () => {
  test('presents the Web product as OpenOPC', () => {
    expect(siteMetadata.name).toBe('OpenOPC');
    expect(siteMetadata.title).toStartWith('OpenOPC');
    expect(siteMetadata.keywords).toStartWith('OpenOPC,');
  });
});
