import { expect, test } from 'bun:test';

import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  assertDeveloperModuleReleaseTransition,
} from './releases';

test('declares the complete release lifecycle without verification outcomes', () => {
  expect(DEVELOPER_MODULE_RELEASE_STATUSES).toEqual([
    'draft',
    'uploaded',
    'validated',
    'verifying',
    'review_pending',
    'changes_requested',
    'approved',
    'signed',
    'published',
    'revoked',
    'deprecated',
  ]);
  expect(DEVELOPER_MODULE_RELEASE_STATUSES).not.toContain('failed');
  expect(DEVELOPER_MODULE_RELEASE_STATUSES).not.toContain('inconclusive');
  expect(DEVELOPER_MODULE_RELEASE_STATUSES).not.toContain('cancelled');
});

test('rejects lifecycle jumps and retains review and deprecation branches', () => {
  expect(() => assertDeveloperModuleReleaseTransition('draft', 'review_pending')).toThrow(
    'DEVELOPER_RELEASE_TRANSITION_INVALID',
  );
  expect(() => assertDeveloperModuleReleaseTransition('draft', 'uploaded')).not.toThrow();
  expect(() => assertDeveloperModuleReleaseTransition('uploaded', 'validated')).not.toThrow();
  expect(() => assertDeveloperModuleReleaseTransition('validated', 'verifying')).not.toThrow();
  expect(() => assertDeveloperModuleReleaseTransition('verifying', 'review_pending')).not.toThrow();
  expect(() =>
    assertDeveloperModuleReleaseTransition('review_pending', 'changes_requested'),
  ).not.toThrow();
  expect(() =>
    assertDeveloperModuleReleaseTransition('changes_requested', 'review_pending'),
  ).not.toThrow();
  expect(() => assertDeveloperModuleReleaseTransition('published', 'deprecated')).not.toThrow();
  expect(() => assertDeveloperModuleReleaseTransition('deprecated', 'revoked')).not.toThrow();
});
