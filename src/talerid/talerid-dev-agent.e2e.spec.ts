/**
 * Live e2e for the agent-direct slice (notes + messages) against TalerID DEV.
 * SKIPPED unless TALERID_E2E=1 + TALERID_* secrets in env. Proves that provisioning
 * with the notes/messages scopes actually exposes those MCP tools (scope gating) and
 * that a note round-trips — the foundation the file-agent + prompt build on. Mail is
 * intentionally NOT requested (separate slice; DEV client has no mail scope yet).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TalerIdOauthClient } from './talerid-oauth.client';

const RUN = process.env.TALERID_E2E === '1' && !!process.env.TALERID_PARTNER_SECRET;
const d = RUN ? describe : describe.skip;

const BASE = process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol';
const PHONE = '+79656445804';
const AGENT_SCOPES = ['mcp:calendar', 'mcp:notes', 'mcp:messages.read', 'mcp:messages.send'];

async function mcp(token: string, name: string, args: any): Promise<any> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'linkeon-agent-e2e', version: '1.0.0' });
  try {
    await client.connect(transport);
    if (name === '__tools__') return (await client.listTools()).tools.map((t: any) => t.name);
    const r: any = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text;
    return { isError: !!r?.isError, data: typeof text === 'string' ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text };
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
  }
}

d('TalerID DEV agent-direct e2e (notes + messages)', () => {
  jest.setTimeout(60000);
  let token = '';
  const createdNoteIds: string[] = [];

  it('provision with notes+messages scopes → grant includes them', async () => {
    const oauth = new TalerIdOauthClient();
    const r = await oauth.provision({ phone: PHONE, scopes: AGENT_SCOPES }) as any;
    console.log('PROVISION scope=%j', r.scope);
    expect(r.ok).toBe(true);
    token = r.accessToken;
    expect(r.scope).toMatch(/mcp:notes/);
    expect(r.scope).toMatch(/mcp:messages\.read/);
    expect(r.scope).toMatch(/mcp:messages\.send/);
  });

  it('tools/list exposes notes + messages tools (and NOT mail)', async () => {
    const tools: string[] = await mcp(token, '__tools__', {});
    console.log('TOOLS:', tools);
    for (const t of ['list_notes', 'create_note', 'update_note', 'delete_note']) {
      expect(tools).toContain(t);
    }
    for (const t of ['list_contacts', 'list_conversations', 'get_messages', 'search_messages', 'send_message']) {
      expect(tools).toContain(t);
    }
    // Mail not requested → must not be visible.
    expect(tools.some((t) => /mail/.test(t))).toBe(false);
  });

  it('create_note → list_notes round-trips the created note', async () => {
    const title = 'Linkeon agent e2e — удалить';
    // NB: `source` is a TalerID Prisma enum (NoteSource), NOT a free string as the
    // contract's `source?: string` implied — passing an arbitrary value errors. Omit it.
    const c = await mcp(token, 'create_note', { title, content: 'sqvoznyak notes' });
    console.log('CREATE_NOTE isError=%s data=%j', c.isError, c.data);
    expect(c.isError).toBe(false);
    const id = c.data?.id || c.data?.note?.id;
    if (id) createdNoteIds.push(id);

    const l = await mcp(token, 'list_notes', { limit: 50 });
    const arr = Array.isArray(l.data) ? l.data : l.data?.notes || [];
    expect(arr.some((n: any) => (n.title || '').includes('Linkeon agent e2e'))).toBe(true);
    // Backfill id from list if create didn't echo one, so cleanup still works.
    if (!id) {
      const found = arr.find((n: any) => (n.title || '').includes('Linkeon agent e2e'));
      if (found?.id) createdNoteIds.push(found.id);
    }
  });

  it('list_contacts is callable under mcp:messages.read (read path)', async () => {
    const r = await mcp(token, 'list_contacts', {});
    console.log('LIST_CONTACTS isError=%s shape=%j', r.isError, Array.isArray(r.data) ? `array[${r.data.length}]` : (r.data && typeof r.data));
    expect(r.isError).toBe(false);
  });

  afterAll(async () => {
    for (const id of createdNoteIds) {
      try { await mcp(token, 'delete_note', { id }); console.log('cleaned note', id); } catch { console.log('cleanup failed', id); }
    }
  });
});
