import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { buildNextDevArgs, wireChildLifecycle, withMaxHttpHeaderSize } from './dev-server.mjs';

test('buildNextDevArgs uses the supplied port and keeps the dev protocol flags', () => {
  assert.deepEqual(buildNextDevArgs('4310'), ['dev', '--turbopack', '--port', '4310']);
});

test('buildNextDevArgs defaults to port 3000 for an empty value', () => {
  assert.deepEqual(buildNextDevArgs(''), ['dev', '--turbopack', '--port', '3000']);
});

test('withMaxHttpHeaderSize appends the required Node option once', () => {
  assert.equal(withMaxHttpHeaderSize(''), '--max-http-header-size=32768');
  assert.equal(
    withMaxHttpHeaderSize('--trace-warnings --max-http-header-size=32768'),
    '--trace-warnings --max-http-header-size=32768',
  );
});

test('package dev scripts use a declared dotenvx binary without shell-only syntax', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.devDependencies['@dotenvx/dotenvx'], '^1.69.2');

  for (const scriptName of ['dev', 'dev:staging-env']) {
    const script = packageJson.scripts[scriptName];
    assert.match(script, /^dotenvx run /);
    assert.match(script, / -- node scripts\/dev-server\.mjs$/);
    assert.doesNotMatch(script, /NODE_OPTIONS=|\$\{WEB_PORT/);
  }
});

test('wireChildLifecycle forwards termination signals and removes listeners on exit', () => {
  const child = new EventEmitter();
  const processLike = new EventEmitter();
  const receivedSignals = [];
  child.killed = false;
  child.kill = (signal) => {
    receivedSignals.push(signal);
    child.killed = true;
    return true;
  };

  wireChildLifecycle(child, processLike, { error() {} });
  processLike.emit('SIGTERM');
  child.emit('exit', 0);

  assert.deepEqual(receivedSignals, ['SIGTERM']);
  assert.equal(processLike.exitCode, 0);
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
});
