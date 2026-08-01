import { Recurrence } from './recurrence';

export interface CalEvent {
  at: string;        // ISO instant (UTC)
  end?: string;
  title: string;
  source: string;    // 'yandex' | 'corp' | ...
  uid?: string;
}

export interface ProposedEvent {
  title: string;
  datetime: string;  // naive local (Asia/Yekaterinburg wall-clock), e.g. "2026-07-20T15:00:00"
  durationMin?: number;
  note?: string;
  recurrence?: Recurrence;
  dates?: string[];
}

export interface Task {
  uid: string;
  title: string;
  due?: string;           // мягкий ориентир по времени (ISO)
  done: boolean;
  source: string;
  // --- модель «твой сегодня» [2026-08-01], все опциональны (обратная совместимость с CalDAV/TalerID) ---
  deadline?: string;      // жёсткий срок, отдельно от due
  recurrence?: Recurrence;// задано → это рутина (повторяющееся дело)
  status?: 'pending' | 'done' | 'dropped';
  isRoutine?: boolean;    // явный флаг (стор Линкеона выставляет при разворачивании серии)
  occurrenceDate?: string;// YYYY-MM-DD: за какой день эта отметка (рутина)
}

export interface ProposedTask {
  title: string;
  datetime?: string; // naive local (Asia/Yekaterinburg wall-clock), e.g. "2026-07-20T09:00:00"
  note?: string;
}

export interface CalendarCreds {
  baseUrl: string;
  username: string;
  appPassword: string;
  collectionUrl?: string;
  taskCollectionUrl?: string;
}

export interface CalendarConnector {
  test(creds: CalendarCreds): Promise<boolean>;
  listEvents(creds: CalendarCreds, start: Date, end: Date): Promise<CalEvent[]>;
  createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ created: number; failed: number; uids: string[]; error?: string }>;
  discoverCollection(creds: CalendarCreds): Promise<string | null>;
  discoverTaskCollection(creds: CalendarCreds): Promise<string | null>;
  createTask(creds: CalendarCreds, task: ProposedTask): Promise<{ uid: string }>;
  listTasks(creds: CalendarCreds, start: Date, end: Date): Promise<Task[]>;
  setTaskDone(creds: CalendarCreds, uid: string, done: boolean): Promise<boolean>;
}
