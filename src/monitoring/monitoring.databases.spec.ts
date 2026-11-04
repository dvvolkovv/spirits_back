import { MonitoringService } from './monitoring.service';

describe('MonitoringService databases: Neo4j Cypher', () => {
  it('не скрывает ошибку count-запросов за healthy JMX up', async () => {
    const neo4j = { readRows: jest.fn().mockRejectedValue(new Error('cypher down')) };
    const service = new MonitoringService(neo4j as any);
    jest.spyOn(service, 'query').mockImplementation(async (promql) => promql === 'up{job="neo4j-jmx"}'
      ? [{ metric: { instance: 'neo4j' }, value: [0, '1'] as [number, string] }]
      : []);

    const overview = await service.getDatabases();

    expect(overview.neo4j).toHaveLength(1);
    expect(overview.neo4j[0].up).toBe(true);
    expect((overview.neo4j[0] as any).error).toBe('source_failed');
  });
});
