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

export interface CalendarCreds {
  baseUrl: string;
  username: string;
  appPassword: string;
  collectionUrl?: string;
}

export interface CalendarConnector {
  test(creds: CalendarCreds): Promise<boolean>;
  listEvents(creds: CalendarCreds, start: Date, end: Date): Promise<CalEvent[]>;
  createEvent(creds: CalendarCreds, event: ProposedEvent): Promise<{ uid: string }>;
}
