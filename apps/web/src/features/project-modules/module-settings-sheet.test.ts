import { describe, expect, test } from 'bun:test';

import { defaultSettingValue, moduleSettingsFormValues } from './module-settings-sheet';

const definition = {
  fields: [
    { key: 'canvas.autosave', label: 'Autosave', type: 'boolean' as const, default: true },
    { key: 'canvas.snap_size', label: 'Snap', type: 'number' as const, min: 1, max: 64 },
    {
      key: 'canvas.background',
      label: 'Background',
      type: 'select' as const,
      options: [
        { value: 'dots', label: 'Dots' },
        { value: 'plain', label: 'Plain' },
      ],
    },
  ],
};

describe('module settings form values', () => {
  test('uses declared defaults and bounded field fallbacks', () => {
    expect(defaultSettingValue(definition.fields[0]!)).toBe(true);
    expect(defaultSettingValue(definition.fields[1]!)).toBe(1);
    expect(defaultSettingValue(definition.fields[2]!)).toBe('dots');
    expect(moduleSettingsFormValues(definition)).toEqual({
      'canvas.autosave': true,
      'canvas.snap_size': 1,
      'canvas.background': 'dots',
    });
  });

  test('overlays only effective values for fields in the signed definition', () => {
    expect(
      moduleSettingsFormValues(definition, {
        schema_version: 1,
        revision: 2,
        values: { 'canvas.autosave': false, stale: 'ignored' },
        loaded_at: '2026-08-11T00:00:00.000Z',
      }),
    ).toEqual({
      'canvas.autosave': false,
      'canvas.snap_size': 1,
      'canvas.background': 'dots',
    });
  });
});
