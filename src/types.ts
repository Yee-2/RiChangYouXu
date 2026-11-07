export type NavKey = 'home' | 'lists' | 'records' | 'community' | 'profile';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Checklist {
  id: string;
  title: string;
  createdAt: string;
  archivedAt?: string;
}

export interface ChecklistItem {
  id: string;
  checklistId: string;
  title: string;
  dueDate?: string;
  note?: string;
  done: boolean;
  createdAt: string;
}

export interface CheckTemplate {
  id: string;
  title: string;
  items: string[];
  createdAt: string;
}

export interface CheckRun {
  id: string;
  templateId: string;
  title: string;
  items: { id: string; title: string; done: boolean }[];
  createdAt: string;
  completedAt?: string;
}

export type UtilityKind = 'water' | 'electricity' | 'gas';
export interface Meter {
  id: string;
  name: string;
  kind: UtilityKind;
  unit: string;
  createdAt: string;
}

export interface MeterReading {
  id: string;
  meterId: string;
  value: number;
  date: string;
  note?: string;
  createdAt: string;
}

export interface Pet {
  id: string;
  name: string;
  kind: string;
  birthday?: string;
  note?: string;
  createdAt: string;
}

export type PetEventKind = 'feeding' | 'weight' | 'vaccine' | 'deworming' | 'visit' | 'custom';
export interface PetEvent {
  id: string;
  petId: string;
  kind: PetEventKind;
  title: string;
  date: string;
  note?: string;
  reminderDate?: string;
  completed: boolean;
  createdAt: string;
}

export interface LocalDatabase {
  checklists: Checklist;
  checklistItems: ChecklistItem;
  checkTemplates: CheckTemplate;
  checkRuns: CheckRun;
  meters: Meter;
  meterReadings: MeterReading;
  pets: Pet;
  petEvents: PetEvent;
  preferences: { key: string; value: unknown };
}

export type StoreName = keyof LocalDatabase;

export interface BackupV1 {
  schemaVersion: 1;
  exportedAt: string;
  data: { [K in StoreName]: LocalDatabase[K][] };
}
