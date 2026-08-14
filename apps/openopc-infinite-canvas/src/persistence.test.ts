import { afterEach, expect, test } from 'bun:test';

import {
  deleteLocalPrompt,
  listLocalPrompts,
  listLocalWorkflows,
  readLocalProject,
  writeLocalPrompt,
  writeLocalProject,
  writeLocalWorkflow,
} from './persistence';
import { createProject } from './project-state';

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('isolates fallback projects by host-provided namespace', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
  });

  const id = 'project-00000000-0000-4000-8000-000000000001';
  await writeLocalProject({ ...createProject(new Date(0), id), title: 'Workspace A' }, 'a:one');
  await writeLocalProject({ ...createProject(new Date(0), id), title: 'Workspace B' }, 'b:two');

  expect((await readLocalProject(id, 'a:one'))?.title).toBe('Workspace A');
  expect((await readLocalProject(id, 'b:two'))?.title).toBe('Workspace B');
  expect(await readLocalProject(id, 'c:three')).toBeNull();
});

test('isolates prompt and workflow libraries by host-provided namespace', async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    },
  });

  await writeLocalPrompt(
    {
      id: 'prompt-a',
      title: '主图',
      content: '白色摄影棚',
      tags: ['电商'],
      source: 'local',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
    'account-a:installation-a',
  );
  await writeLocalWorkflow(
    {
      id: 'workflow-a',
      title: '商品主图',
      description: '文案到图片',
      variables: [],
      steps: [{ id: 'step-a', kind: 'text', title: '卖点', prompt: '整理卖点' }],
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
    'account-a:installation-a',
  );

  expect(await listLocalPrompts('account-a:installation-a')).toHaveLength(1);
  expect(await listLocalPrompts('account-b:installation-b')).toEqual([]);
  expect(await listLocalWorkflows('account-a:installation-a')).toHaveLength(1);
  await deleteLocalPrompt('prompt-a', 'account-a:installation-a');
  expect(await listLocalPrompts('account-a:installation-a')).toEqual([]);
});
