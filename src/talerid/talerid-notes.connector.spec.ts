import { TalerIdNotesConnector } from './talerid-notes.connector';

describe('TalerIdNotesConnector [6ad042df]', () => {
  const makeOauth = () => ({ getBackendAccessToken: jest.fn().mockResolvedValue('access-token-1') }) as any;

  describe('listNotes', () => {
    it('маппит id/title/content/updatedAt в TalerIdNote', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue([
        { id: 'n1', title: 'Идеи', content: 'текст', updatedAt: '2026-07-20T10:00:00+05:00' },
      ]);
      const result = await connector.listNotes('user-1');
      expect(callTool).toHaveBeenCalledWith('user-1', 'list_notes', { limit: 100 });
      expect(result).toEqual([
        { id: 'n1', title: 'Идеи', content: 'текст', updatedAt: new Date('2026-07-20T10:00:00+05:00').toISOString() },
      ]);
    });

    it('принимает форму {notes:[...]} и snake_case updated_at', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue({
        notes: [{ id: 'n2', title: 'T', content: 'C', updated_at: '2026-07-21T09:00:00Z' }],
      });
      const result = await connector.listNotes('user-1');
      expect(result[0]).toMatchObject({ id: 'n2', updatedAt: '2026-07-21T09:00:00.000Z' });
    });

    it('заметку без id пропускает, остальные сохраняет (не роняет пачку)', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue([
        { title: 'без id', content: 'x' },
        { id: 'n3', title: 'ok', content: 'y' },
      ]);
      const result = await connector.listNotes('user-1');
      expect(result.map((n) => n.id)).toEqual(['n3']);
    });

    it('любой сбой callTool → [] (best-effort, панель не падает)', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockRejectedValue(new Error('mcp down'));
      expect(await connector.listNotes('user-1')).toEqual([]);
    });

    it('не-массив/кривой payload → []', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue({ unexpected: true });
      expect(await connector.listNotes('user-1')).toEqual([]);
    });
  });

  describe('createNote', () => {
    it('зовёт create_note с {title, content} и возвращает {ok, id}', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue({ id: 'n9', title: 'Купить' });
      const r = await connector.createNote('user-1', 'Купить', 'купить молоко');
      expect(callTool).toHaveBeenCalledWith('user-1', 'create_note', { title: 'Купить', content: 'купить молоко' });
      expect(r).toMatchObject({ ok: true, id: 'n9' });
    });

    it('сбой → {ok:false, error} (не бросает)', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockRejectedValue(new Error('mcp down'));
      const r = await connector.createNote('user-1', 'T', 'C');
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });
  });

  describe('updateNote', () => {
    it('зовёт update_note с {id, title, content} и возвращает {ok, id}', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue({ id: 'n5', title: 'Заголовок' });
      const r = await connector.updateNote('user-1', 'n5', 'Заголовок', 'исправленный текст.');
      expect(callTool).toHaveBeenCalledWith('user-1', 'update_note', { id: 'n5', title: 'Заголовок', content: 'исправленный текст.' });
      expect(r).toMatchObject({ ok: true, id: 'n5' });
    });

    it('сбой → {ok:false, error}', async () => {
      const connector = new TalerIdNotesConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockRejectedValue(new Error('mcp down'));
      const r = await connector.updateNote('user-1', 'n5', 'T', 'C');
      expect(r.ok).toBe(false);
    });
  });
});
