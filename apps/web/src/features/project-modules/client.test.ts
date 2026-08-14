import { describe, expect, test } from 'bun:test';
import { moduleServiceDeclarations, moduleSettingsDefinition } from './client';

describe('project module service declarations', () => {
  test('reads data and settings operations from a signed v3 manifest', () => {
    expect(
      moduleServiceDeclarations({
        schemaVersion: 3,
        openopc: {
          sdkApiVersion: 'v1',
          services: {
            data: { operations: ['documents.read', 'documents.write'] },
            settings: { operations: ['settings.read'] },
          },
        },
      }),
    ).toEqual([
      { service: 'data', operations: ['documents.read', 'documents.write'] },
      { service: 'settings', operations: ['settings.read'] },
    ]);
  });

  test('rejects a cross-service operation instead of partially declaring it', () => {
    expect(
      moduleServiceDeclarations({
        schemaVersion: 3,
        openopc: {
          sdkApiVersion: 'v1',
          services: { settings: { operations: ['documents.read'] } },
        },
      }),
    ).toEqual([]);
  });
});

describe('project module settings definition', () => {
  test('reads sorted non-sensitive fields from a signed v3 manifest', () => {
    expect(
      moduleSettingsDefinition({
        schemaVersion: 3,
        openopc: {
          sdkApiVersion: 'v1',
          settings: {
            fields: [
              { key: 'canvas.autosave', label: 'Autosave', type: 'boolean', default: true },
              {
                key: 'canvas.background',
                label: 'Background',
                type: 'select',
                options: [
                  { value: 'dots', label: 'Dots' },
                  { value: 'plain', label: 'Plain' },
                ],
              },
            ],
          },
        },
      }),
    ).toEqual({
      fields: [
        { key: 'canvas.autosave', label: 'Autosave', type: 'boolean', default: true },
        {
          key: 'canvas.background',
          label: 'Background',
          type: 'select',
          options: [
            { value: 'dots', label: 'Dots' },
            { value: 'plain', label: 'Plain' },
          ],
        },
      ],
    });
  });

  test('fails closed for credential-like keys and malformed options', () => {
    expect(
      moduleSettingsDefinition({
        schemaVersion: 3,
        openopc: {
          sdkApiVersion: 'v1',
          settings: {
            fields: [{ key: 'provider.api_key', label: 'Key', type: 'text' }],
          },
        },
      }),
    ).toBeNull();
    expect(
      moduleSettingsDefinition({
        schemaVersion: 3,
        openopc: {
          sdkApiVersion: 'v1',
          settings: {
            fields: [{ key: 'canvas.mode', label: 'Mode', type: 'select' }],
          },
        },
      }),
    ).toBeNull();
  });
});
