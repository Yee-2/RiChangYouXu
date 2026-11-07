import { openDB, type IDBPDatabase } from 'idb';
import type { LocalDatabase, StoreName } from './types';

const DB_NAME = 'daily-life-local';
const DB_VERSION = 1;
let dbPromise: Promise<IDBPDatabase<LocalDatabase>> | undefined;

function database() {
  dbPromise ??= openDB<LocalDatabase>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('checklists', { keyPath: 'id' });
      db.createObjectStore('checklistItems', { keyPath: 'id' });
      db.createObjectStore('checkTemplates', { keyPath: 'id' });
      db.createObjectStore('checkRuns', { keyPath: 'id' });
      db.createObjectStore('meters', { keyPath: 'id' });
      const readings = db.createObjectStore('meterReadings', { keyPath: 'id' });
      readings.createIndex('meterId', 'meterId');
      db.createObjectStore('pets', { keyPath: 'id' });
      const events = db.createObjectStore('petEvents', { keyPath: 'id' });
      events.createIndex('petId', 'petId');
      db.createObjectStore('preferences', { keyPath: 'key' });
    }
  });
  return dbPromise;
}

export async function all<K extends StoreName>(store: K): Promise<LocalDatabase[K][]> {
  return (await database()).getAll(store);
}

export async function put<K extends StoreName>(store: K, value: LocalDatabase[K]) {
  return (await database()).put(store, value);
}

export async function remove<K extends StoreName>(store: K, id: string) {
  return (await database()).delete(store, id);
}

export async function getPreference<T>(key: string, fallback: T): Promise<T> {
  const result = await (await database()).get('preferences', key);
  return (result?.value as T | undefined) ?? fallback;
}

export async function setPreference(key: string, value: unknown) {
  return put('preferences', { key, value });
}

export async function clearPersonalData() {
  const db = await database();
  const tx = db.transaction(['checklists', 'checklistItems', 'checkTemplates', 'checkRuns', 'meters', 'meterReadings', 'pets', 'petEvents'], 'readwrite');
  await Promise.all([
    tx.objectStore('checklists').clear(), tx.objectStore('checklistItems').clear(),
    tx.objectStore('checkTemplates').clear(), tx.objectStore('checkRuns').clear(),
    tx.objectStore('meters').clear(), tx.objectStore('meterReadings').clear(),
    tx.objectStore('pets').clear(), tx.objectStore('petEvents').clear()
  ]);
  await tx.done;
}

export async function exportPersonalData() {
  const stores: StoreName[] = ['checklists', 'checklistItems', 'checkTemplates', 'checkRuns', 'meters', 'meterReadings', 'pets', 'petEvents'];
  const data = Object.fromEntries(await Promise.all(stores.map(async (store) => [store, await all(store)])));
  return { schemaVersion: 1 as const, exportedAt: new Date().toISOString(), data };
}

export async function importPersonalData(payload: unknown) {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件格式不正确。');
  const backup = payload as { schemaVersion?: number; data?: Record<string, unknown> };
  const stores: StoreName[] = ['checklists', 'checklistItems', 'checkTemplates', 'checkRuns', 'meters', 'meterReadings', 'pets', 'petEvents'];
  if (backup.schemaVersion !== 1 || !backup.data || stores.some((store) => !Array.isArray(backup.data?.[store]))) {
    throw new Error('暂不支持此备份版本，或备份内容不完整。');
  }
  const records = new Map<StoreName, Array<Record<string, unknown>>>();
  for (const store of stores) {
    const entries = backup.data[store] as Array<Record<string, unknown>>;
    if (entries.some((item) => !item || typeof item.id !== 'string')) throw new Error(`备份中的 ${store} 记录缺少有效 ID。`);
    records.set(store, entries);
  }
  const db = await database();
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) {
    for (const item of records.get(store) ?? []) {
      await tx.objectStore(store).put(item as never);
    }
  }
  await tx.done;
}
