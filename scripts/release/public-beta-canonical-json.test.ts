import { expect, test } from 'bun:test';

import {
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
  computePublicBetaSha256,
  encodeCanonicalPublicBetaJson,
} from './public-beta-canonical-json';

test('uses RFC 8785 ordering and number serialization', () => {
  expect(
    canonicalPublicBetaJson({ literals: [null, true, false], numbers: [1e30, 4.5, 0.002] }),
  ).toBe('{"literals":[null,true,false],"numbers":[1e+30,4.5,0.002]}');
  expect(canonicalPublicBetaJson({ '\u20ac': 'Euro', '\r': 'CR', '1': 'one' })).toBe(
    '{"\\r":"CR","1":"one","\u20ac":"Euro"}',
  );
  expect(canonicalPublicBetaJson({ '\ufb33': 'Hebrew', '\ud83d\ude00': 'Grinning' })).toBe(
    '{"\ud83d\ude00":"Grinning","\ufb33":"Hebrew"}',
  );
});

test('encodes canonical JSON as UTF-8 and hashes raw bytes', () => {
  const encoded = encodeCanonicalPublicBetaJson({ currency: '\u20ac', enabled: true });
  expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded)).toBe(
    '{"currency":"\u20ac","enabled":true}',
  );
  expect(computePublicBetaSha256(encoded)).toBe(
    computePublicBetaSha256('{"currency":"\u20ac","enabled":true}'),
  );
});

test.each([
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1n,
  undefined,
  new Date(0),
  // biome-ignore lint/suspicious/noSparseArray: A hole is the invalid input under test.
  [, 1],
])('rejects non-I-JSON value %p', (value) =>
  expect(() => canonicalPublicBetaJson(value)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID'),
);

test('rejects a derived array as a non-plain JSON container', () => {
  class DerivedArray extends Array<number> {}
  const value = new DerivedArray();
  value.push(1);

  expect(() => canonicalPublicBetaJson(value)).toThrow(
    'PUBLIC_BETA_CANONICAL_JSON_INVALID',
  );
});

test('rejects an array with a replaced prototype as a non-plain JSON container', () => {
  const value = [1];
  Object.setPrototypeOf(value, null);

  expect(() => canonicalPublicBetaJson(value)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID');
});

test.each([() => undefined, Symbol('top-level'), { value: () => undefined }, { value: Symbol() }])(
  'rejects function and symbol values %p',
  (value) => expect(() => canonicalPublicBetaJson(value)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID'),
);

test.each(['\ud800', '\udfff', { '\ud800': 'key' }, { value: '\udfff' }])(
  'rejects lone surrogate value %p',
  (value) =>
    expect(() => canonicalPublicBetaJson(value)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID'),
);

test('rejects direct and indirect cycles', () => {
  const direct: { self?: unknown } = {};
  direct.self = direct;

  const left: { right?: unknown } = {};
  const right = { left };
  left.right = right;

  expect(() => canonicalPublicBetaJson(direct)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID');
  expect(() => canonicalPublicBetaJson(left)).toThrow('PUBLIC_BETA_CANONICAL_JSON_INVALID');
});

test('allows repeated acyclic references', () => {
  const shared = { value: 1 };
  expect(canonicalPublicBetaJson({ left: shared, right: shared })).toBe(
    '{"left":{"value":1},"right":{"value":1}}',
  );
});

test('produces a lowercase sha256 digest over canonical UTF-8 bytes', () => {
  expect(computeCanonicalPublicBetaDigest({ b: 2, a: 1 })).toBe(
    'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );
});
