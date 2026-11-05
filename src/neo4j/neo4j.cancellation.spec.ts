import { Neo4jService } from './neo4j.service';

describe('Neo4jService cancellation', () => {
  it('pre-aborted readRows не оставляет поздний reject session.run без обработчика', async () => {
    let rejectRun: ((error: Error) => void) | undefined;
    const session = {
      run: jest.fn(() => new Promise((_resolve, reject) => { rejectRun = reject; })),
      close: jest.fn(async () => {}),
    };
    const service = new Neo4jService();
    (service as any).driver = { session: () => session };
    const controller = new AbortController();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      controller.abort(new Error('pre-aborted'));
      await expect(service.readRows('MATCH (n) RETURN n', {}, controller.signal))
        .rejects.toThrow('pre-aborted');
      rejectRun?.(new Error('late session rejection'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(session.run).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(session.close).toHaveBeenCalledTimes(1);
    } finally {
      rejectRun?.(new Error('spec cleanup'));
      process.off('unhandledRejection', unhandled);
    }
  });
});
