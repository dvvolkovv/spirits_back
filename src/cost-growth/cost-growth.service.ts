import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { costGrowthConfig, detectCostGrowth, type TurnCost } from './cost-growth.rule';

/** Чей это разговор: веб-чат — человек и ассистент; TG-бот — бот и чат, платит владелец бота. */
export type CostPair =
  | { kind: 'chat'; userId: string; assistantId: string }
  | { kind: 'tg'; configId: string; chatId: string; payerUserId: string; botName?: string };

export const pairKey = (p: CostPair): string =>
  p.kind === 'chat' ? `chat:${p.userId}:${p.assistantId}` : `tg:${p.configId}:${p.chatId}`;

/** Сколько последних ходов пары хранить и сколько (сек) — с последнего хода. */
const KEEP_TURNS = 10;
const HISTORY_TTL_S = 24 * 3600;

/**
 * Дописать ход и вернуть историю — одним атомарным вызовом: между RPUSH и
 * LRANGE не вклинится ход того же разговора из соседней вкладки.
 */
const PUSH_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LRANGE', KEYS[1], 0, -1)
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n: number) => Math.round(n).toLocaleString('ru');

/** Текст алерта: кто, цепочка ходов в токенах и $, во сколько раз вырос, остаток, расклад последнего хода. */
export function formatCostGrowthAlert(pair: CostPair, run: TurnCost[], balance?: number): string {
  const first = run[0];
  const last = run[run.length - 1];
  const who =
    pair.kind === 'chat'
      ? `Юзер: <code>${esc(pair.userId)}</code>, ассистент ${esc(pair.assistantId)}`
      : `TG-бот <code>${esc(pair.configId)}</code>${pair.botName ? ` («${esc(pair.botName)}»)` : ''}, ` +
        `чат <code>${esc(pair.chatId)}</code>, платит <code>${esc(pair.payerUserId)}</code>`;
  const factor = (last.tokens / first.tokens).toFixed(1).replace('.', ',');
  return (
    `📈 <b>Стоимость растёт с каждым ответом</b>\n` +
    `${who}\n` +
    `Ходы: ${run.map((t) => fmt(t.tokens)).join(' → ')} токенов ` +
    `(${run.map((t) => `$${t.usd.toFixed(2)}`).join(' → ')}), ×${factor}\n` +
    (balance !== undefined && balance >= 0 ? `Остаток: ${fmt(balance)}\n` : '') +
    (last.note ? `Последний ход: <code>${esc(last.note)}</code>` : '')
  ).trimEnd();
}

/**
 * Сторож «стоимость растёт с каждым ответом» (спека
 * docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md).
 *
 * Зовётся без ожидания сразу после списания хода; никогда не бросает:
 * недоступный Redis или Telegram — предупреждение в лог, ход идёт как шёл.
 */
@Injectable()
export class CostGrowthService {
  private readonly logger = new Logger(CostGrowthService.name);

  constructor(private readonly redis: RedisService) {}

  async recordTurn(pair: CostPair, turn: TurnCost, ctx?: { balance?: () => Promise<number> }): Promise<void> {
    if (!(turn.tokens > 0)) return;
    try {
      const cfg = costGrowthConfig();
      const key = pairKey(pair);
      const raw = (await this.redis.eval(PUSH_SCRIPT, [`cost-growth:turns:${key}`], [
        JSON.stringify({ tokens: turn.tokens, usd: turn.usd, note: turn.note, at: turn.at ?? Date.now() }),
        KEEP_TURNS,
        HISTORY_TTL_S,
      ])) as string[];
      const history: TurnCost[] = raw.map((s) => JSON.parse(s));
      const run = detectCostGrowth(history, cfg);
      if (!run) return;
      const first = await this.redis.setNx(`cost-growth:alerted:${key}`, String(Date.now()), cfg.cooldownH * 3600_000);
      if (!first) return;
      const balance = ctx?.balance ? await ctx.balance().catch(() => -1) : undefined;
      await sendTelegramAlert(formatCostGrowthAlert(pair, run, balance));
    } catch (e: any) {
      this.logger.warn(`cost-growth: ход не учтён (${pairKey(pair)}): ${e?.message ?? e}`);
    }
  }
}
