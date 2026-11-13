import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as path from 'path';
import { CustomAgentsService } from './custom-agents.service';

describe('CustomAgentsService normal remove при account deletion', () => {
  function makeService(options: { referenced: boolean }) {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (s.startsWith('SELECT id, owner_user_id, name, description, system_prompt')) {
          return {
            rows: [{
              id: 'ca-1', owner_user_id: 'u-deleted', name: 'Role', description: null,
              system_prompt: 'ЛИЧНЫЙ-ТЕКСТ', created_at: '2026-11-01', updated_at: '2026-11-01',
            }],
            rowCount: 1,
          };
        }
        if (s.startsWith('SELECT id, display_name FROM tg_bot_configs')) {
          return {
            rows: options.referenced ? [{ id: 'cfg-archived', display_name: 'Archived bot' }] : [],
            rowCount: options.referenced ? 1 : 0,
          };
        }
        if (s.startsWith('DELETE FROM custom_agents')) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected query: ${s}`);
      }),
    };
    return { svc: new CustomAgentsService(pg as any, {} as any), pg, calls };
  }

  it('обычный remove по-прежнему блокируется даже archived FK и не заменяет account purge', async () => {
    const { svc, calls } = makeService({ referenced: true });

    await expect(svc.remove('ca-1', 'u-deleted')).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some(({ sql }) => sql.startsWith('DELETE FROM custom_agents'))).toBe(false);
  });

  it('обычный remove без ссылок сохраняет прежний owner-scoped DELETE без deletion generation', async () => {
    const { svc, calls } = makeService({ referenced: false });

    await svc.remove('ca-1', 'u-deleted');

    const deletion = calls.find(({ sql }) => sql.startsWith('DELETE FROM custom_agents'));
    expect(deletion).toBeDefined();
    expect(deletion?.params).toEqual(['ca-1', 'u-deleted']);
    expect(deletion?.sql).toContain('id = $1 AND owner_user_id = $2');
    expect(deletion?.sql).not.toContain('deletion_id');
  });

  it('рядом с normal remove зафиксировано, почему account purge идёт отдельным FK-safe job', () => {
    const source = readFileSync(path.join(__dirname, 'custom-agents.service.ts'), 'utf8');
    const removeBody = source.slice(source.indexOf('async remove('), source.indexOf('async draftPrompt('));

    expect(removeBody).toMatch(/normal remove/i);
    expect(removeBody).toMatch(/account deletion/i);
    expect(removeBody).toMatch(/telegram\.purge[\s\S]*custom-agent\.purge/);
  });
});
