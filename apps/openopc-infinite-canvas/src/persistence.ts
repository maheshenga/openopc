import type { CanvasProject, PromptRecord, WorkflowRecord } from './types';

const DATABASE_NAME = 'openopc-infinite-canvas-v1';
const DATABASE_VERSION = 2;
const PROJECT_STORE = 'projects';
const ASSET_STORE = 'assets';
const PROMPT_STORE = 'prompts';
const WORKFLOW_STORE = 'workflows';

export interface LocalAsset {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  source?: string;
  note?: string;
}

function namespaceHash(namespace: string): string {
  let hash = 2166136261;
  for (let index = 0; index < namespace.length; index += 1) {
    hash ^= namespace.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function databaseName(namespace: string): string {
  return `${DATABASE_NAME}-${namespaceHash(namespace)}`;
}

function localKey(namespace: string, kind: string, id: string): string {
  return `openopc-infinite-canvas:${namespaceHash(namespace)}:${kind}:${id}`;
}

function openDatabase(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(databaseName(namespace), DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        database.createObjectStore(ASSET_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(PROMPT_STORE)) {
        database.createObjectStore(PROMPT_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(WORKFLOW_STORE)) {
        database.createObjectStore(WORKFLOW_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function writeRecord<T extends { id: string }>(
  storeName: string,
  kind: string,
  value: T,
  namespace: string,
): Promise<void> {
  try {
    await transaction<void>(namespace, storeName, 'readwrite', (store, finish, fail) => {
      const request = store.put(value);
      request.onerror = () => fail(request.error ?? new Error('IndexedDB write failed'));
      request.onsuccess = () => finish(undefined);
    });
  } catch {
    const current = readFallbackRecords<T>(namespace, kind);
    const next = [value, ...current.filter((item) => item.id !== value.id)];
    try {
      localStorage.setItem(localKey(namespace, kind, 'all'), JSON.stringify(next));
    } catch {
      // Metadata persistence remains best effort when browser storage is restricted.
    }
  }
}

function readFallbackRecords<T>(namespace: string, kind: string): T[] {
  try {
    const value = localStorage.getItem(localKey(namespace, kind, 'all'));
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function listRecords<T>(storeName: string, kind: string, namespace: string): Promise<T[]> {
  try {
    return await transaction<T[]>(namespace, storeName, 'readonly', (store, finish) => {
      const request = store.getAll();
      request.onerror = () => finish([]);
      request.onsuccess = () => finish((request.result as T[]) ?? []);
    });
  } catch {
    return readFallbackRecords<T>(namespace, kind);
  }
}

async function deleteRecord(
  storeName: string,
  kind: string,
  id: string,
  namespace: string,
): Promise<void> {
  try {
    await transaction<void>(namespace, storeName, 'readwrite', (store, finish, fail) => {
      const request = store.delete(id);
      request.onerror = () => fail(request.error ?? new Error('IndexedDB delete failed'));
      request.onsuccess = () => finish(undefined);
    });
  } catch {
    try {
      const next = readFallbackRecords<{ id: string }>(namespace, kind).filter(
        (item) => item.id !== id,
      );
      localStorage.setItem(localKey(namespace, kind, 'all'), JSON.stringify(next));
    } catch {
      // Metadata cleanup is best effort in storage-restricted contexts.
    }
  }
}

async function transaction<T>(
  namespace: string,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, finish: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  const database = await openDatabase(namespace);
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed'));
    try {
      run(store, finish, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export async function readLocalProject(
  id: string,
  namespace = 'local',
): Promise<CanvasProject | null> {
  try {
    return await transaction<CanvasProject | null>(
      namespace,
      PROJECT_STORE,
      'readonly',
      (store, finish) => {
        const request = store.get(id);
        request.onerror = () => finish(null);
        request.onsuccess = () => finish((request.result as CanvasProject | undefined) ?? null);
      },
    );
  } catch {
    try {
      const value = localStorage.getItem(localKey(namespace, 'project', id));
      return value ? (JSON.parse(value) as CanvasProject) : null;
    } catch {
      return null;
    }
  }
}

export async function writeLocalProject(
  project: CanvasProject,
  namespace = 'local',
): Promise<void> {
  try {
    await transaction<void>(namespace, PROJECT_STORE, 'readwrite', (store, finish, fail) => {
      const request = store.put(project);
      request.onerror = () => fail(request.error ?? new Error('IndexedDB write failed'));
      request.onsuccess = () => finish(undefined);
    });
  } catch {
    try {
      localStorage.setItem(localKey(namespace, 'project', project.id), JSON.stringify(project));
      const current = readFallbackRecords<CanvasProject>(namespace, 'projects');
      const next = [project, ...current.filter((item) => item.id !== project.id)];
      localStorage.setItem(localKey(namespace, 'projects', 'all'), JSON.stringify(next));
    } catch {
      // Local persistence is best effort; the editor remains usable in private browsing.
    }
  }
}

export async function listLocalProjects(namespace = 'local'): Promise<CanvasProject[]> {
  try {
    return await transaction<CanvasProject[]>(
      namespace,
      PROJECT_STORE,
      'readonly',
      (store, finish) => {
        const request = store.getAll();
        request.onerror = () => finish([]);
        request.onsuccess = () => finish((request.result as CanvasProject[]) ?? []);
      },
    );
  } catch {
    return readFallbackRecords<CanvasProject>(namespace, 'projects');
  }
}

export async function deleteLocalProject(id: string, namespace = 'local'): Promise<void> {
  try {
    await transaction<void>(namespace, PROJECT_STORE, 'readwrite', (store, finish, fail) => {
      const request = store.delete(id);
      request.onerror = () => fail(request.error ?? new Error('IndexedDB project delete failed'));
      request.onsuccess = () => finish(undefined);
    });
  } catch {
    try {
      localStorage.removeItem(localKey(namespace, 'project', id));
      const next = readFallbackRecords<CanvasProject>(namespace, 'projects').filter(
        (project) => project.id !== id,
      );
      localStorage.setItem(localKey(namespace, 'projects', 'all'), JSON.stringify(next));
    } catch {
      // Project cleanup is best effort in storage-restricted contexts.
    }
  }
}

export async function writeLocalAsset(asset: LocalAsset, namespace = 'local'): Promise<void> {
  await transaction<void>(namespace, ASSET_STORE, 'readwrite', (store, finish, fail) => {
    const request = store.put(asset);
    request.onerror = () => fail(request.error ?? new Error('IndexedDB asset write failed'));
    request.onsuccess = () => finish(undefined);
  });
}

export async function readLocalAsset(id: string, namespace = 'local'): Promise<LocalAsset | null> {
  try {
    return await transaction<LocalAsset | null>(
      namespace,
      ASSET_STORE,
      'readonly',
      (store, finish) => {
        const request = store.get(id);
        request.onerror = () => finish(null);
        request.onsuccess = () => finish((request.result as LocalAsset | undefined) ?? null);
      },
    );
  } catch {
    return null;
  }
}

export async function listLocalAssets(namespace = 'local'): Promise<LocalAsset[]> {
  try {
    return await transaction<LocalAsset[]>(namespace, ASSET_STORE, 'readonly', (store, finish) => {
      const request = store.getAll();
      request.onerror = () => finish([]);
      request.onsuccess = () => finish((request.result as LocalAsset[]) ?? []);
    });
  } catch {
    return [];
  }
}

export async function deleteLocalAsset(id: string, namespace = 'local'): Promise<void> {
  try {
    await transaction<void>(namespace, ASSET_STORE, 'readwrite', (store, finish, fail) => {
      const request = store.delete(id);
      request.onerror = () => fail(request.error ?? new Error('IndexedDB asset delete failed'));
      request.onsuccess = () => finish(undefined);
    });
  } catch {
    // Asset cleanup is best effort and never blocks canvas edits.
  }
}

export function writeLocalPrompt(prompt: PromptRecord, namespace = 'local'): Promise<void> {
  return writeRecord(PROMPT_STORE, 'prompts', prompt, namespace);
}

export function listLocalPrompts(namespace = 'local'): Promise<PromptRecord[]> {
  return listRecords(PROMPT_STORE, 'prompts', namespace);
}

export function deleteLocalPrompt(id: string, namespace = 'local'): Promise<void> {
  return deleteRecord(PROMPT_STORE, 'prompts', id, namespace);
}

export function writeLocalWorkflow(workflow: WorkflowRecord, namespace = 'local'): Promise<void> {
  return writeRecord(WORKFLOW_STORE, 'workflows', workflow, namespace);
}

export function listLocalWorkflows(namespace = 'local'): Promise<WorkflowRecord[]> {
  return listRecords(WORKFLOW_STORE, 'workflows', namespace);
}

export function deleteLocalWorkflow(id: string, namespace = 'local'): Promise<void> {
  return deleteRecord(WORKFLOW_STORE, 'workflows', id, namespace);
}
