import { describe, expect, test } from 'bun:test';

import {
  confirmedServiceConsentAction,
  moduleServiceConsentDialogView,
} from './module-service-consent-dialog';

describe('module service consent dialog', () => {
  test('shows the exact declared operations without provider configuration', () => {
    const view = moduleServiceConsentDialogView('ai', ['models.read', 'text.generate'], null);
    const serialized = JSON.stringify(view);

    expect(view.title).toContain('AI service access');
    expect(view.operations).toEqual(['models.read', 'text.generate']);
    expect(serialized).not.toMatch(/new-api|z-pay|alipay|wechat|merchant|webhook|credential/i);
  });

  test('requires an explicit confirmation before grant or revoke can submit', () => {
    expect(confirmedServiceConsentAction('grant', false)).toBeNull();
    expect(confirmedServiceConsentAction('revoke', false)).toBeNull();
    expect(confirmedServiceConsentAction('grant', true)).toBe('grant');
    expect(confirmedServiceConsentAction('revoke', true)).toBe('revoke');
  });
});
