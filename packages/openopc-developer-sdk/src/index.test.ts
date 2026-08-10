import { expect, test } from 'bun:test';

import { createOpenOpcBrowserModuleClient } from './index';

test('exports the one-call browser module constructor', () => {
  expect(typeof createOpenOpcBrowserModuleClient).toBe('function');
});
