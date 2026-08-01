import { expect, test } from 'bun:test';

import { RESTRICTED_DISABLED_CAPABILITIES } from '../../packages/api-contract/src/release-profile';

type CapabilityPrefixItem = {
  allOf: readonly [unknown, { properties: { capability: { const: string } } }];
};

test('disabled-state schema fixes the exact eleven capability records in order', async () => {
  const schema = await Bun.file(
    'tests/public-beta/disabled-state-assessment.v1.schema.json',
  ).json();
  const records = schema.properties.records;
  expect(records.minItems).toBe(11);
  expect(records.maxItems).toBe(11);
  expect(records.items).toBe(false);
  const capabilities = (records.prefixItems as CapabilityPrefixItem[]).map(
    (item) => item.allOf[1].properties.capability.const,
  );
  expect(capabilities).toEqual(RESTRICTED_DISABLED_CAPABILITIES);
});
