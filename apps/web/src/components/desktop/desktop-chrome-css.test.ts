import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const globalsCss = readFileSync(join(import.meta.dir, '../../app/globals.css'), 'utf8').replaceAll(
  '\r\n',
  '\n',
);

describe('desktop chrome pointer safety', () => {
  test('keeps the control spacer inert off macOS and restores only the macOS top strip', () => {
    expect(globalsCss).toContain(
      "html[data-desktop='true'] .kx-desktop-drag {\n  flex: 1;\n  pointer-events: none;\n  -webkit-app-region: no-drag;\n  app-region: no-drag;\n}",
    );
    expect(globalsCss).toContain(
      "html[data-desktop-platform='macos'] .kx-desktop-drag {\n  pointer-events: auto;\n  -webkit-app-region: drag;",
    );
  });
});
