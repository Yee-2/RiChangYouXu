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

export interface BackupPreview {
  exportedAt: string;
  total: number;
  stores: Array<{ store: StoreName; label: string; count: number; added: number; overwritten: number }>;
}

const backupStores: StoreName[] = ['checklists', 'checklistItems', 'checkTemplates', 'checkRuns', 'meters', 'meterReadings', 'pets', 'petEvents'];
const storeLabels: Record<StoreName, string> = {
  checklists: '生活清单', checklistItems: '待办事项', checkTemplates: '出门检查模板', checkRuns: '检查进度',
  meters: '表具', meterReadings: '抄表记录', pets: '宠物档案', petEvents: '宠物事件', preferences: '偏好设置'
};
type BackupRecord = Record<string, unknown>;
type PreparedBackup = { records: Map<StoreName, BackupRecord[]>; preview: BackupPreview };

export async function previewPersonalImport(payload: unknown): Promise<BackupPreview> {
  return (await prepareBackup(payload)).preview;
}

export async function importPersonalData(payload: unknown): Promise<BackupPreview> {
  const { records, preview } = await prepareBackup(payload);
  const db = await database();
  const tx = db.transaction(backupStores, 'readwrite');
  try {
    await Promise.all(backupStores.flatMap((store) => (records.get(store) ?? []).map((record) => tx.objectStore(store).put(record as never))));
    await tx.done;
    return preview;
  } catch (error) {
    try { tx.abort(); } catch { /* the transaction may already be inactive */ }
    throw error;
  }
}

async function prepareBackup(payload: unknown): Promise<PreparedBackup> {
  if (!isRecord(payload)) throw new Error('备份文件格式不正确。');
  const backup = payload as { schemaVersion?: number; exportedAt?: unknown; data?: Record<string, unknown> };
  if (backup.schemaVersion !== 1 || !isRecord(backup.data) || !isDateTime(backup.exportedAt)) {
    throw new Error('暂不支持此备份版本，或备份信息不完整。');
  }

  const records = new Map<StoreName, BackupRecord[]>();
  for (const store of backupStores) {
    const entries = backup.data[store];
    if (!Array.isArray(entries)) throw new Error(`备份缺少“${storeLabels[store]}”数据。`);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) throw new Error(`“${storeLabels[store]}”中有记录缺少有效 ID。`);
      if (seen.has(entry.id)) throw new Error(`“${storeLabels[store]}”中有重复 ID：${entry.id}`);
      seen.add(entry.id);
      if (!isValidRecord(store, entry)) throw new Error(`“${storeLabels[store]}”中有字段无效的记录（ID：${entry.id}）。`);
    }
    records.set(store, entries as BackupRecord[]);
  }

  const current = new Map<StoreName, BackupRecord[]>();
  for (const store of backupStores) current.set(store, await all(store) as BackupRecord[]);
  const checklistIds = new Set([...(current.get('checklists') ?? []), ...(records.get('checklists') ?? [])].map((item) => item.id));
  const meterIds = new Set([...(current.get('meters') ?? []), ...(records.get('meters') ?? [])].map((item) => item.id));
  const petIds = new Set([...(current.get('pets') ?? []), ...(records.get('pets') ?? [])].map((item) => item.id));
  if ((records.get('checklistItems') ?? []).some((item) => !checklistIds.has(item.checklistId as string))) throw new Error('备份包含找不到所属清单的事项，未导入任何数据。');
  if ((records.get('meterReadings') ?? []).some((item) => !meterIds.has(item.meterId as string))) throw new Error('备份包含找不到表具的抄表记录，未导入任何数据。');
  if ((records.get('petEvents') ?? []).some((item) => !petIds.has(item.petId as string))) throw new Error('备份包含找不到所属宠物的事件，未导入任何数据。');

  const stores = backupStores.map((store) => {
    const existingIds = new Set((current.get(store) ?? []).map((item) => item.id));
    const incoming = records.get(store) ?? [];
    const overwritten = incoming.filter((item) => existingIds.has(item.id)).length;
    return { store, label: storeLabels[store], count: incoming.length, added: incoming.length - overwritten, overwritten };
  });
  return { records, preview: { exportedAt: backup.exportedAt, total: stores.reduce((sum, item) => sum + item.count, 0), stores } };
}

function isRecord(value: unknown): value is BackupRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasOptionalDate(record: BackupRecord, key: string) {
  return record[key] === undefined || record[key] === '' || isDateOnly(record[key]);
}

function isValidRecord(store: StoreName, record: BackupRecord): boolean {
  const idValid = typeof record.id === 'string' && record.id.trim().length > 0;
  const created = isDateTime(record.createdAt);
  switch (store) {
    case 'checklists': return idValid && typeof record.title === 'string' && record.title.trim().length > 0 && record.title.length <= 60 && created && (record.archivedAt === undefined || isDateTime(record.archivedAt));
    case 'checklistItems': return idValid && typeof record.checklistId === 'string' && typeof record.title === 'string' && record.title.trim().length > 0 && record.title.length <= 100 && typeof record.done === 'boolean' && created && (record.completedAt === undefined || isDateTime(record.completedAt)) && hasOptionalDate(record, 'dueDate') && (record.note === undefined || typeof record.note === 'string' && record.note.length <= 500);
    case 'checkTemplates': return idValid && typeof record.title === 'string' && record.title.trim().length > 0 && record.title.length <= 60 && Array.isArray(record.items) && record.items.length > 0 && record.items.every((item) => typeof item === 'string' && item.trim().length > 0) && created;
    case 'checkRuns': return idValid && typeof record.templateId === 'string' && typeof record.title === 'string' && record.title.trim().length > 0 && Array.isArray(record.items) && record.items.length > 0 && record.items.every((item) => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && item.title.trim().length > 0 && typeof item.done === 'boolean') && created && (record.completedAt === undefined || isDateTime(record.completedAt));
    case 'meters': return idValid && typeof record.name === 'string' && record.name.trim().length > 0 && ['water', 'electricity', 'gas'].includes(String(record.kind)) && typeof record.unit === 'string' && record.unit.length > 0 && created;
    case 'meterReadings': return idValid && typeof record.meterId === 'string' && typeof record.value === 'number' && Number.isFinite(record.value) && record.value >= 0 && isDateOnly(record.date) && created && (record.note === undefined || typeof record.note === 'string' && record.note.length <= 200);
    case 'pets': return idValid && typeof record.name === 'string' && record.name.trim().length > 0 && typeof record.kind === 'string' && record.kind.trim().length > 0 && created && hasOptionalDate(record, 'birthday') && (record.note === undefined || typeof record.note === 'string');
    case 'petEvents': return idValid && typeof record.petId === 'string' && ['feeding', 'weight', 'vaccine', 'deworming', 'visit', 'custom'].includes(String(record.kind)) && typeof record.title === 'string' && record.title.trim().length > 0 && isDateOnly(record.date) && typeof record.completed === 'boolean' && created && hasOptionalDate(record, 'reminderDate') && (record.note === undefined || typeof record.note === 'string');
    default: return false;
  }
}
