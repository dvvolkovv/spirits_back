import { FunnelService } from './funnel.service';
import { allChatFailureTexts } from '../../chat/chat-failure-texts';

const FROM = '2026-11-04T00:00:00.000Z';
const TO = '2026-11-05T00:00:00.000Z';

describe('воронка: заглушки сбоев на всех языках не считаются ответами', () => {
  it('шаг ai-ответа исключает все тексты allChatFailureTexts(), шаг сообщения — нет', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await new FunnelService(pg as any).getFunnel(FROM, TO, null);
    const history = pg.query.mock.calls.filter(([sql]: any[]) => /custom_chat_history/.test(String(sql)));
    const ai = history.find(([, params]: any[]) => params?.[4] === 'ai');
    const human = history.find(([, params]: any[]) => params?.[4] === 'human');
    expect(ai).toBeDefined();
    expect(human).toBeDefined();
    expect(String(ai![0])).toContain('<> ALL($6::text[])');
    expect(ai![1][5]).toEqual(allChatFailureTexts());
    expect(String(human![0])).not.toContain('$6');
    expect(human![1]).toHaveLength(5);
  });
});
