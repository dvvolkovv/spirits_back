import { AgentsService } from './agents.service';

describe('AgentsService.getAgents с локалью', () => {
  const makePg = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) as any;

  it('передаёт локаль параметром запроса', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('es');
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('agent_translations'), ['es']);
  });

  it('нормализует региональный вариант локали', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('es-MX');
    expect(pg.query).toHaveBeenCalledWith(expect.any(String), ['es']);
  });

  it('без локали берёт русский', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents();
    expect(pg.query).toHaveBeenCalledWith(expect.any(String), ['ru']);
  });

  it('запрос деградирует в русские колонки через COALESCE', async () => {
    const pg = makePg();
    await new AgentsService(pg).getAgents('de');
    const sql = pg.query.mock.calls[0][0];
    expect(sql).toContain('COALESCE');
    expect(sql).toContain('LEFT JOIN');
  });
});
