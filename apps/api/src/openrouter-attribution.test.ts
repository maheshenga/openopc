import { expect, test } from 'bun:test';
import { OPENROUTER_APP_REFERER, OPENROUTER_APP_TITLE } from './openrouter-attribution';

test('keeps the stable OpenRouter attribution key while showing the product brand', () => {
  expect(OPENROUTER_APP_REFERER).toBe('https://www.kortix.com');
  expect(OPENROUTER_APP_TITLE).toBe('OpenOPC');
});
