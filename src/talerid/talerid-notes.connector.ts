import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TalerIdOauthService } from './talerid-oauth.service';

function mcpBaseUrl(): string {
  const base = process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol';
  return `${base.replace(/\/$/, '')}/mcp`;
}

/** Заметка пользователя из TalerID (scope `mcp:notes`). Нормализованная форма для панели заметок. */
export interface TalerIdNote {
  id: string;
  title: string;
  content: string;
  /** ISO-инстант последнего изменения, если TalerID его отдаёт. */
  updatedAt?: string;
}

/**
 * TalerID notes connector (scope `mcp:notes`) [6ad042df]. Фундамент для панели заметок da5290c7:
 * отдаёт список заметок пользователя. Тот же паттерн, что у TalerIdCalendarConnector — stateless
 * Streamable HTTP MCP, свежий per-user Bearer, транспорт открывается/закрывается на каждый вызов.
 *
 * Best-effort: любой сбой (не подключён / MCP-ошибка / кривой payload) → `[]`, не бросаем — панель
 * заметок при недоступном TalerID просто покажет пусто, а не упадёт.
 */
@Injectable()
export class TalerIdNotesConnector {
  private readonly logger = new Logger(TalerIdNotesConnector.name);

  constructor(private readonly oauth: TalerIdOauthService) {}

  /** Открыть stateless MCP-транспорт с per-user токеном, вызвать инструмент, распарсить JSON из
   *  единственного `text`-блока, который TalerID всегда возвращает. Бросает на no-token/isError/сбой. */
  protected async callTool(userId: string, name: string, args: Record<string, any>): Promise<any> {
    const token = await this.oauth.getBackendAccessToken(userId);
    if (!token) throw new Error('talerid: not connected (no access token)');

    const transport = new StreamableHTTPClientTransport(new URL(mcpBaseUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'linkeon-talerid-connector', version: '1.0.0' });
    try {
      await client.connect(transport);
      const result: any = await client.callTool({ name, arguments: args });
      if (result?.isError) {
        const msg = result?.content?.[0]?.text ?? 'unknown MCP error';
        throw new Error(`talerid mcp ${name} isError: ${msg}`);
      }
      const text = result?.content?.[0]?.text;
      return typeof text === 'string' ? JSON.parse(text) : text;
    } finally {
      try { await client.close(); } catch { /* best-effort cleanup */ }
      try { await transport.close(); } catch { /* best-effort cleanup */ }
    }
  }

  /** Список заметок пользователя. Дефолтит в [] при любой проблеме. */
  async listNotes(userId: string): Promise<TalerIdNote[]> {
    try {
      const raw = await this.callTool(userId, 'list_notes', {});
      const notes = Array.isArray(raw) ? raw : Array.isArray(raw?.notes) ? raw.notes : [];
      const out: TalerIdNote[] = [];
      for (const n of notes) {
        if (!n?.id) continue; // без id заметку не адресовать (правка/удаление в панели) — пропускаем одну, не роняем пачку
        const item: TalerIdNote = {
          id: String(n.id),
          title: String(n.title || '').trim(),
          content: String(n.content || ''),
        };
        const upd = n.updatedAt || n.updated_at;
        if (upd) {
          const ms = new Date(upd).getTime();
          if (!Number.isNaN(ms)) item.updatedAt = new Date(ms).toISOString();
        }
        out.push(item);
      }
      return out;
    } catch (e: any) {
      this.logger.debug(`talerid listNotes degraded to [] for user ${userId}: ${e?.message}`);
      return [];
    }
  }
}
