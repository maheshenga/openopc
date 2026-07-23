import { expect, test } from 'bun:test';
import { BrowserWorkerConnectionError } from './browser-worker-connection';
import type { VerifiedWorkerPeer } from './worker-auth';

type State = 'connecting' | 'ready' | 'unusable';

type TestConnection = Readonly<{
  peer: VerifiedWorkerPeer;
  state(): State;
  subscribe(listener: (state: State) => void): () => void;
  send(input: unknown): Promise<unknown>;
  close(reason?: string): void;
}>;

type ManagedModule = Readonly<{
  createManagedBrowserWorkerConnection(input: {
    peer: VerifiedWorkerPeer;
    connect(): TestConnection;
    schedule(callback: () => void, delayMs: number): unknown;
    cancel(handle: unknown): void;
    initialBackoffMs: number;
    maxBackoffMs: number;
  }): Readonly<{
    peer: VerifiedWorkerPeer;
    isReady(): boolean;
    send(input: unknown): Promise<unknown>;
    close(reason?: string): void;
  }>;
}>;

const peer: VerifiedWorkerPeer = Object.freeze({
  serviceId: 'browser-worker-1',
  role: 'browser-worker',
  certificateFingerprint256: 'AA:BB:CC:DD',
  certificateExpiresAt: '2099-07-24T06:00:00.000Z',
});

class FakeConnection implements TestConnection {
  readonly peer = peer;
  readonly sends: unknown[] = [];
  readonly closeReasons: Array<string | undefined> = [];
  unsubscribeAttempts = 0;
  #state: State = 'connecting';
  #listeners = new Set<(state: State) => void>();
  #nextFailure: BrowserWorkerConnectionError | undefined;

  constructor(
    private readonly options: {
      throwOnUnsubscribe?: boolean;
      throwOnClose?: boolean;
    } = {},
  ) {}

  state(): State {
    return this.#state;
  }

  subscribe(listener: (state: State) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.unsubscribeAttempts += 1;
      this.#listeners.delete(listener);
      if (this.options.throwOnUnsubscribe) throw new Error('unsubscribe hook failed');
    };
  }

  emitState(state: State): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  rejectNext(error: BrowserWorkerConnectionError): void {
    this.#nextFailure = error;
  }

  send(input: unknown): Promise<unknown> {
    this.sends.push(input);
    const failure = this.#nextFailure;
    this.#nextFailure = undefined;
    return failure === undefined ? Promise.resolve({ accepted: true }) : Promise.reject(failure);
  }

  close(reason?: string): void {
    this.closeReasons.push(reason);
    if (this.options.throwOnClose) throw new Error('connection close failed');
    this.emitState('unusable');
  }
}

function createScheduler(options: { throwOnCancel?: boolean } = {}) {
  type Scheduled = { callback: () => void; delayMs: number; cancelled: boolean };
  const scheduled: Scheduled[] = [];
  let cancelAttempts = 0;
  return {
    scheduled,
    schedule: (callback: () => void, delayMs: number): Scheduled => {
      const handle = { callback, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancel: (raw: unknown): void => {
      cancelAttempts += 1;
      if (options.throwOnCancel) throw new Error('timer cancel failed');
      (raw as Scheduled).cancelled = true;
    },
    cancelAttempts: (): number => cancelAttempts,
    runNext(): void {
      const next = scheduled.find((entry) => !entry.cancelled);
      if (next === undefined) throw new Error('no scheduled reconnect');
      next.cancelled = true;
      next.callback();
    },
    activeCount(): number {
      return scheduled.filter((entry) => !entry.cancelled).length;
    },
  };
}

async function managedModule(): Promise<ManagedModule | null> {
  return import('./managed-browser-worker-connection').catch(
    () => null,
  ) as Promise<ManagedModule | null>;
}

test('discards an unknown-result connection and reconnects without replaying the dispatch', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const first = new FakeConnection();
  const second = new FakeConnection();
  const connections = [first, second];
  const scheduler = createScheduler();
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => connections.shift() as FakeConnection,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
  });

  expect(managed.peer).toBe(peer);
  expect(managed.isReady()).toBeFalse();
  first.emitState('ready');
  expect(managed.isReady()).toBeTrue();
  first.rejectNext(new BrowserWorkerConnectionError('unknown', 'unknown_result'));
  const dispatchInput = { lease: 'current' };
  await expect(managed.send(dispatchInput)).rejects.toMatchObject({ reason: 'unknown_result' });
  expect(managed.isReady()).toBeFalse();
  expect(first.closeReasons).toHaveLength(1);
  expect(first.sends).toEqual([dispatchInput]);
  expect(scheduler.activeCount()).toBe(1);

  scheduler.runNext();
  second.emitState('ready');
  expect(managed.isReady()).toBeTrue();
  expect(second.sends).toHaveLength(0);
});

test('keeps exactly one reconnect timer and caps exponential backoff', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const allConnections = Array.from({ length: 8 }, () => new FakeConnection());
  const connections = [...allConnections];
  const scheduler = createScheduler();
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => connections.shift() as FakeConnection,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 60_000,
  });
  const expectedDelays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
  allConnections[0]?.emitState('ready');
  expect(managed.isReady()).toBeTrue();

  for (const [index, expectedDelay] of expectedDelays.entries()) {
    const active = allConnections[index];
    if (active === undefined) throw new Error('missing fake connection');
    active.emitState('unusable');
    expect(managed.isReady()).toBeFalse();
    active.emitState('unusable');
    expect(scheduler.activeCount()).toBe(1);
    expect(scheduler.scheduled.at(-1)?.delayMs).toBe(expectedDelay);
    scheduler.runNext();
  }
});

test('does not replace or retry a connection for an in-flight rejection', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const connection = new FakeConnection();
  const scheduler = createScheduler();
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => connection,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
  });
  connection.emitState('ready');
  connection.rejectNext(new BrowserWorkerConnectionError('busy', 'in_flight'));

  await expect(managed.send({ lease: 'current' })).rejects.toMatchObject({ reason: 'in_flight' });
  expect(managed.isReady()).toBeTrue();
  expect(connection.closeReasons).toHaveLength(0);
  expect(scheduler.activeCount()).toBe(0);
});

test('preserves unknown-result classification and bounded reconnect when disposal hooks throw', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const first = new FakeConnection({ throwOnUnsubscribe: true, throwOnClose: true });
  const second = new FakeConnection();
  const connections = [first, second];
  const scheduler = createScheduler();
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => connections.shift() as FakeConnection,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 10_000,
    maxBackoffMs: 60_000,
  });
  first.emitState('ready');
  first.rejectNext(new BrowserWorkerConnectionError('unknown', 'unknown_result'));

  await expect(managed.send({ lease: 'current' })).rejects.toMatchObject({
    message: 'unknown',
    reason: 'unknown_result',
  });
  expect(first.unsubscribeAttempts).toBe(1);
  expect(first.closeReasons).toHaveLength(1);
  expect(scheduler.activeCount()).toBe(1);
  expect(scheduler.scheduled.at(-1)?.delayMs).toBe(5_000);

  scheduler.runNext();
  second.emitState('ready');
  expect(managed.isReady()).toBeTrue();
  expect(second.sends).toHaveLength(0);
});

test('shutdown attempts independent cleanup when every hook throws and remains idempotent', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const connection = new FakeConnection({ throwOnUnsubscribe: true, throwOnClose: true });
  const scheduler = createScheduler({ throwOnCancel: true });
  let factoryCalls = 0;
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => {
      factoryCalls += 1;
      return connection;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
  });
  connection.emitState('unusable');

  expect(() => managed.close('shutdown')).not.toThrow();
  expect(() => managed.close('again')).not.toThrow();
  expect(scheduler.cancelAttempts()).toBe(1);
  expect(connection.unsubscribeAttempts).toBe(1);
  expect(connection.closeReasons).toEqual(['shutdown']);
  await expect(managed.send({ lease: 'future' })).rejects.toMatchObject({
    reason: 'unavailable',
  });

  scheduler.runNext();
  expect(factoryCalls).toBe(1);
  expect(scheduler.activeCount()).toBe(0);
});

test('bounds retries when the connection factory fails synchronously', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const recovered = new FakeConnection();
  const scheduler = createScheduler();
  let factoryCalls = 0;
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => {
      factoryCalls += 1;
      if (factoryCalls < 3) throw new Error('connection factory failed');
      return recovered;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
  });

  expect(scheduler.scheduled.at(-1)?.delayMs).toBe(250);
  scheduler.runNext();
  expect(scheduler.scheduled.at(-1)?.delayMs).toBe(500);
  scheduler.runNext();
  recovered.emitState('ready');
  expect(factoryCalls).toBe(3);
  expect(managed.isReady()).toBeTrue();
  expect(scheduler.activeCount()).toBe(0);
});

test('closes idempotently, cancels reconnect, and rejects future sends', async () => {
  const module = await managedModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const connection = new FakeConnection();
  const scheduler = createScheduler();
  const managed = module.createManagedBrowserWorkerConnection({
    peer,
    connect: () => connection,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
  });
  connection.emitState('unusable');
  expect(scheduler.activeCount()).toBe(1);

  managed.close('shutdown');
  managed.close('again');

  expect(scheduler.activeCount()).toBe(0);
  expect(connection.closeReasons).toEqual(['shutdown']);
  await expect(managed.send({ lease: 'future' })).rejects.toMatchObject({ reason: 'unavailable' });
});
