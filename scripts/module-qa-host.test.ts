import { expect, test } from 'bun:test';
import { canonicalModuleQaOrigin, parseModuleQaHostOptions } from './module-qa-host';

test('keeps the module QA origin canonical HTTPS without a port', () => {
  expect(canonicalModuleQaOrigin('image.openopc.test')).toBe('https://image.openopc.test');
  expect(() => canonicalModuleQaOrigin('image.openopc.test:8443')).toThrow();
  expect(() => canonicalModuleQaOrigin('localhost.openopc.test')).toThrow();
  expect(() => canonicalModuleQaOrigin('127.0.0.1')).toThrow();
});

test('accepts only loopback HTTP upstreams with an explicit development port', () => {
  const options = parseModuleQaHostOptions([
    '--hostname',
    'image.openopc.test',
    '--upstream',
    'http://127.0.0.1:4173',
    '--cert',
    'cert.pem',
    '--key',
    'cert-key.pem',
  ]);
  expect(options.upstream.origin).toBe('http://127.0.0.1:4173');
  expect(() =>
    parseModuleQaHostOptions([
      '--hostname',
      'image.openopc.test',
      '--upstream',
      'https://image.openopc.test:4173',
      '--cert',
      'cert.pem',
      '--key',
      'cert-key.pem',
    ]),
  ).toThrow();
});
