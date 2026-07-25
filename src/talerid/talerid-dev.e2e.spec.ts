/**
 * Live end-to-end sqvoznyak against TalerID DEV (staging.id.taler.tirol).
 * SKIPPED unless TALERID_E2E=1 + the TALERID_* secrets are in env — never runs in CI/unit.
 * Verifies the real provision → MCP list/create/refresh chain and the two shapes we built
 * against a mock (create_calendar_event response, list_calendar_events param names).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TalerIdOauthClient } from './talerid-oauth.client';
import { TalerIdOauthService } from './talerid-oauth.service';
import { TalerIdCalendarConnector } from './talerid-calendar.connector';

const RUN = process.env.TALERID_E2E === '1' && !!process.env.TALERID_PARTNER_SECRET;
const d = RUN ? describe : describe.skip;

const BASE = process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol';
const PHONE = '+79656445804';

// Minimal in-memory store so we can drive the real service+connector without a DB.
class MemStore {
  private c: any = null;
  async getConnection() { return this.c; }
  async saveConnection(userId: string, v: any) { this.c = { userId, ...v, status: 'connected' }; }
  async setStatus(_u: string, status: string) { if (this.c) this.c.status = status; }
  async getRefresh() { return this.c?.refreshToken ?? null; }
  async getAccess() { return this.c ? { accessToken: this.c.accessToken, expiresAt: this.c.accessExpiresAt } : null; }
  async updateRefresh(_u: string, r: string) { if (this.c) this.c.refreshToken = r; }
  async updateAccess(_u: string, a: string, e: Date) { if (this.c) { this.c.accessToken = a; this.c.accessExpiresAt = e; } }
  async delete() { this.c = null; }
}

async function rawMcp(token: string, name: string, args: any): Promise<any> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'linkeon-e2e', version: '1.0.0' });
  try {
    await client.connect(transport);
    if (name === '__tools__') return (await client.listTools()).tools.map((t: any) => t.name);
    const r: any = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text;
    return { isError: !!r?.isError, data: typeof text === 'string' ? JSON.parse(text) : text };
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

d('TalerID DEV e2e', () => {
  jest.setTimeout(60000);
  const createdIds: string[] = [];
  let accessToken = '';

  it('provision returns tokens + talerid_user_id', async () => {
    const oauth = new TalerIdOauthClient();
    const r = await oauth.provision({ phone: PHONE, scopes: ['mcp:calendar'] });
    // eslint-disable-next-line no-console
    console.log('PROVISION ok=%s scope=%j taleridUserId.len=%d', (r as any).ok, (r as any).scope, ((r as any).taleridUserId || '').length);
    expect((r as any).ok).toBe(true);
    accessToken = (r as any).accessToken;
    expect(accessToken.length).toBeGreaterThan(20);
    expect((r as any).refreshToken.length).toBeGreaterThan(20);
  });

  it('MCP tools/list is calendar-only (scope gating)', async () => {
    const tools = await rawMcp(accessToken, '__tools__', {});
    console.log('TOOLS:', tools);
    expect(tools.some((t: string) => t.includes('calendar'))).toBe(true);
    expect(tools.some((t: string) => /note|message|mail/.test(t))).toBe(false);
  });

  it('raw create_calendar_event → capture the REAL response shape', async () => {
    const r = await rawMcp(accessToken, 'create_calendar_event', {
      title: 'Linkeon e2e — удалить', type: 'EVENT',
      startAt: '2026-09-01T10:00:00+05:00', endAt: '2026-09-01T11:00:00+05:00',
      description: 'sqvoznyak',
    });
    console.log('CREATE RESPONSE keys=%j sample=%j', r.data && typeof r.data === 'object' ? Object.keys(r.data) : typeof r.data, r.data);
    expect(r.isError).toBe(false);
    const id = r.data?.id || r.data?.event?.id || r.data?.eventId;
    expect(id).toBeTruthy();
    createdIds.push(id);
  });

  it('raw list_calendar_events (from/to) returns the created event', async () => {
    const r = await rawMcp(accessToken, 'list_calendar_events', { from: '2026-09-01', to: '2026-09-02' });
    console.log('LIST RESPONSE shape=%j', Array.isArray(r.data) ? `array[${r.data.length}]` : (r.data && Object.keys(r.data)));
    const arr = Array.isArray(r.data) ? r.data : r.data?.events || [];
    expect(arr.some((e: any) => (e.title || '').includes('Linkeon e2e'))).toBe(true);
  });

  it('CONNECTOR listEvents + createEvent work against real DEV', async () => {
    const store = new MemStore() as any;
    const oauth = new TalerIdOauthService(store, new TalerIdOauthClient());
    await oauth.connect('u1', PHONE);
    const conn = new TalerIdCalendarConnector(oauth);
    const events = await conn.listEvents('u1', new Date('2026-09-01'), new Date('2026-09-02'));
    console.log('CONNECTOR listEvents ->', events.length, 'events; sample', events[0]);
    expect(events.length).toBeGreaterThan(0);
    const w = await conn.createEvent('u1', { title: 'Linkeon e2e connector — удалить', datetime: '2026-09-03T09:00:00', durationMin: 30 } as any);
    console.log('CONNECTOR createEvent ->', w);
    expect(w.created).toBe(1);
    createdIds.push(...w.ids);
  });

  it('refresh mints a fresh access that still works', async () => {
    const oauth = new TalerIdOauthClient();
    const prov = await oauth.provision({ phone: PHONE, scopes: ['mcp:calendar'] }) as any;
    const refreshed = await oauth.refresh(prov.refreshToken, ['mcp:calendar']);
    expect(refreshed.accessToken.length).toBeGreaterThan(20);
    const tools = await rawMcp(refreshed.accessToken, '__tools__', {});
    expect(tools.some((t: string) => t.includes('calendar'))).toBe(true);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      try { await rawMcp(accessToken, 'delete_calendar_event', { id }); console.log('cleaned', id); } catch (e) { console.log('cleanup failed', id); }
    }
  });
});
