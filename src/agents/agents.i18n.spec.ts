import { AgentsService } from './agents.service';

describe('AgentsService.getAgents с локалью', () => {
  const makePg = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) as any;

  // Локаль проверяем по позиции, а не сверяя массив параметров целиком: вторым
  // параметром идёт список служебных агентов, и жёсткое сравнение ломалось бы
  // от любого нового параметра, не относящегося к языку.
  const langParam = (pg: any) => pg.query.mock.calls[0][1][0];

  it('передаёт локаль параметром запроса', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('es');
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('agent_translations'), expect.any(Array));
    expect(langParam(pg)).toBe('es');
  });

  it('нормализует региональный вариант локали', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('es-MX');
    expect(langParam(pg)).toBe('es');
  });

  it('без локали берёт русский', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents();
    expect(langParam(pg)).toBe('ru');
  });

  it('запрос деградирует в русские колонки через COALESCE', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('de');
    const sql = pg.query.mock.calls[0][0];
    expect(sql).toContain('COALESCE');
    expect(sql).toContain('LEFT JOIN');
  });
});
