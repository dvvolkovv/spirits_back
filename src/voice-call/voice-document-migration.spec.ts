import { DOC_PLACES, collectLegacyDocRefs } from './voice-document-migration';

/**
 * Ссылки на голосовые документы прежнего вида — documents/<id>/<docId>.md —
 * для разового переноса (спека 2026-11-02-pii-out-of-prompts-design.md, п. 2).
 * Сам перенос на живом SQL — voice-document-migration.pg.spec.ts.
 */
const PUB = 'https://my.linkeon.io/smm-media/linkeon-assets';
const DOC = '0a0b0c0d-1111-4222-8333-444455556666';
const DOC2 = '9f8e7d6c-1111-4222-8333-444455556666';
const UUID_USER = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('collectLegacyDocRefs', () => {
  it('папка — номер: ссылка прежнего вида', () => {
    expect(collectLegacyDocRefs(`[Открыть документ полностью](${PUB}/documents/70000000000/${DOC}.md)`)).toEqual([
      { oldKey: `documents/70000000000/${DOC}.md`, folder: '70000000000', docId: DOC },
    ]);
  });

  it('папка — идентификатор пользователя почты (uuid): тоже прежний вид', () => {
    expect(collectLegacyDocRefs(`${PUB}/documents/${UUID_USER}/${DOC}.md`)).toEqual([
      { oldKey: `documents/${UUID_USER}/${DOC}.md`, folder: UUID_USER, docId: DOC },
    ]);
  });

  it('новая папка — 32 hex солёного хэша — не прежний вид', () => {
    expect(collectLegacyDocRefs(`${PUB}/documents/${'ab'.repeat(16)}/${DOC}.md`)).toEqual([]);
  });

  it('документы других бакетов и чужие пути не трогаются', () => {
    expect(collectLegacyDocRefs(`https://x/linkeon-chat-files/documents/70000000000/${DOC}.md`)).toEqual([]);
    expect(collectLegacyDocRefs(`documents/file_7.xlsx и linkeon-assets/documents/70000000000/readme.md`)).toEqual([]);
  });

  it('ссылка внутри JSON расшифровки встречи', () => {
    const transcript = JSON.stringify([
      { role: 'assistant', text: `[в чат] Документ «План»: ${PUB}/documents/70000000000/${DOC}.md`, ts: 1 },
    ]);
    expect(collectLegacyDocRefs(transcript).map((r) => r.docId)).toEqual([DOC]);
  });

  it('повторы в одном тексте — один раз, разные документы — каждый', () => {
    const one = `${PUB}/documents/70000000000/${DOC}.md`;
    const two = `${PUB}/documents/70000000000/${DOC2}.md`;
    expect(collectLegacyDocRefs(`${one}\n${one}\n${two}`).map((r) => r.docId)).toEqual([DOC, DOC2]);
  });
});

describe('DOC_PLACES', () => {
  it('история чата и расшифровка встречи — в перечне мест', () => {
    const places = DOC_PLACES.map((p) => `${p.table}.${p.column}`);
    expect(places).toEqual(expect.arrayContaining(['custom_chat_history.content', 'voice_calls.transcript']));
  });
});
