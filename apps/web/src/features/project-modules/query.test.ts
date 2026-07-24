import { describe, expect, test } from 'bun:test';

import { projectModuleErrorCode } from './query';

describe('Project Modules query errors', () => {
  test('maps API error payloads carried in the SDK data field', () => {
    expect(
      projectModuleErrorCode({
        status: 409,
        data: { error: 'PROJECT_MODULE_INSTALL_CONFLICT' },
      }),
    ).toBe('PROJECT_MODULE_INSTALL_CONFLICT');
  });
});
