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
}

export interface Task {
  uid: string;
  title: string;
  due?: string;
  done: boolean;
  source: string;
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
  createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ uid: string }>;
  discoverCollection(creds: CalendarCreds): Promise<string | null>;
  discoverTaskCollection(creds: CalendarCreds): Promise<string | null>;
  createTask(creds: CalendarCreds, task: ProposedTask): Promise<{ uid: string }>;
  listTasks(creds: CalendarCreds, start: Date, end: Date): Promise<Task[]>;
  setTaskDone(creds: CalendarCreds, uid: string, done: boolean): Promise<boolean>;
}
