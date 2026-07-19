import { ChatToolsService } from './chat-tools';

function svc(status: any, conflicts: any[]) {
  const calendar = { getStatus: async () => status, findConflicts: async () => conflicts } as any;
  // остальные зависимости не нужны для этой ветки — передать заглушки
  return new ChatToolsService({} as any, {} as any, {} as any, {} as any, {} as any, calendar);
}

describe('propose_calendar_event tool', () => {
  it('connected: returns proposal with conflicts', async () => {
    const r: any = await svc({ connected: true }, [{ title: 'Встреча', at: '2026-07-20T10:00:00Z' }])
      .executeTool('u1', 'propose_calendar_event', { title: 'Синк', datetime: '2026-07-20T15:00:00' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_proposal', connected: true });
    expect(r.conflicts).toHaveLength(1);
  });
  it('not connected: returns proposal with connected:false, no calendar read', async () => {
    const r: any = await svc({ connected: false }, [])
      .executeTool('u1', 'propose_calendar_event', { title: 'Синк', datetime: '2026-07-20T15:00:00' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_proposal', connected: false });
    expect(r.conflicts).toEqual([]);
  });
});
