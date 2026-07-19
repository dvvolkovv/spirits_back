import { ChatToolsService } from './chat-tools';

function svc(status: any, conflicts: any[], findConflictsFn?: jest.Mock) {
  const getStatusFn = jest.fn(async () => status);
  const findConflictsImpl = findConflictsFn || jest.fn(async () => conflicts);
  const saveProposalFn = jest.fn(async () => 'test-id');
  const calendar = { getStatus: getStatusFn, findConflicts: findConflictsImpl, saveProposal: saveProposalFn } as any;
  // остальные зависимости не нужны для этой ветки — передать заглушки
  return { svc: new ChatToolsService({} as any, {} as any, {} as any, {} as any, {} as any, calendar), findConflictsFn: findConflictsImpl, saveProposalFn };
}

describe('propose_calendar_event tool', () => {
  it('connected: returns proposal with conflicts', async () => {
    const { svc: service, findConflictsFn, saveProposalFn } = svc({ connected: true }, [{ title: 'Встреча', at: '2026-07-20T10:00:00Z' }]);
    const r: any = await service.executeTool('u1', 'propose_calendar_event', { title: 'Синк', datetime: '2026-07-20T15:00:00' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_proposal', connected: true, proposalId: 'test-id' });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toEqual({ title: 'Встреча', at: '2026-07-20T10:00:00Z' });
    expect(saveProposalFn).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 'Синк' }), true, r.conflicts);
  });
  it('not connected: returns proposal with connected:false, no calendar read', async () => {
    const findConflictsFn = jest.fn(async () => []);
    const { svc: service, saveProposalFn } = svc({ connected: false }, [], findConflictsFn);
    const r: any = await service.executeTool('u1', 'propose_calendar_event', { title: 'Синк', datetime: '2026-07-20T15:00:00' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_proposal', connected: false, proposalId: 'test-id' });
    expect(r.conflicts).toEqual([]);
    expect(findConflictsFn).not.toHaveBeenCalled();
    expect(saveProposalFn).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 'Синк' }), false, []);
  });
});
