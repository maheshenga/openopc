import { describe, expect, test } from 'bun:test';

import {
  DEVELOPER_MODULE_INPUT_MAX_BYTES,
  developerCenterErrorCode,
  filterRecentReleases,
  parseDeveloperModuleInput,
  publisherActionFor,
  requirementComplexity,
} from './model';

describe('Developer Center model', () => {
  test('exposes only legal publisher actions', () => {
    expect(publisherActionFor('validated')).toBe('request_review');
    expect(publisherActionFor('changes_requested')).toBe('resubmit');
    expect(publisherActionFor('review_pending')).toBeNull();
    expect(publisherActionFor('approved')).toBeNull();
    expect(publisherActionFor('revoked')).toBeNull();
  });

  test('rejects malformed and over-limit JSON before an API call', () => {
    expect(parseDeveloperModuleInput('{')).toEqual({ ok: false, code: 'INVALID_JSON' });
    expect(parseDeveloperModuleInput('x'.repeat(DEVELOPER_MODULE_INPUT_MAX_BYTES + 1))).toEqual({
      ok: false,
      code: 'INPUT_TOO_LARGE',
    });
    expect(parseDeveloperModuleInput('{"type":"registry:module"}')).toEqual({
      ok: true,
      item: { type: 'registry:module' },
    });
  });

  test('filters only loaded recent rows without claiming a total', () => {
    const rows = [
      {
        module_id: 'acme.recruiting',
        item_name: 'Recruiting',
        publisher_id: 'acme',
        module_version: '1.0.0',
        status: 'review_pending',
      },
      {
        module_id: 'city.listings',
        item_name: 'Listings',
        publisher_id: 'city',
        module_version: '2.0.0',
        status: 'approved',
      },
    ] as never[];
    expect(filterRecentReleases(rows, 'recruit', 'review_pending')).toHaveLength(1);
    expect(filterRecentReleases(rows, '', 'all')).toHaveLength(2);
  });

  test('maps unknown errors to a stable non-secret code', () => {
    expect(developerCenterErrorCode({ message: 'Bearer private-token' })).toBe(
      'DEVELOPER_REQUEST_FAILED',
    );
    expect(
      developerCenterErrorCode({ status: 409, body: { error: 'DEVELOPER_REVIEW_CONFLICT' } }),
    ).toBe('DEVELOPER_REVIEW_CONFLICT');
    expect(developerCenterErrorCode({ code: 'DEVELOPER_INTERNAL_SECRET' })).toBe(
      'DEVELOPER_REQUEST_FAILED',
    );
  });

  test('derives complexity only from declared requirements', () => {
    expect(requirementComplexity(['manifest_review', 'human_review'])).toBe('standard');
    expect(requirementComplexity(['desktop_security_review', 'human_review'])).toBe('elevated');
  });
});
