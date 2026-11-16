import * as fs from 'fs';
import * as path from 'path';
import { chatFailureText, allChatFailureTexts, ChatFailureKind } from './chat-failure-texts';
import { ChatService } from './chat.service';
import { looksLikeFailure } from '../routine-push/routine-push.service';

const LANGS = ['ru', 'en', 'es', 'de', 'fr', 'zh', 'pt'];
const KINDS: ChatFailureKind[] = ['relayUpdating', 'startFailed', 'fileFailed', 'noReply', 'cliFatal'];
const VARIANTS = [{}, { upload: true }, { storeBuild: true }, { storeBuild: true, upload: true }];
const MONEY = /token|токен|jeton|代币|balance|баланс|saldo|guthaben|solde|余额|пополн/i;

describe('chatFailureText', () => {
  it('7 языков × 5 видов × 4 варианта — ни одного пустого', () => {
    for (const lang of LANGS) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(chatFailureText(kind, lang, v).trim().length).toBeGreaterThan(10);
    }
  });

  it('магазинные варианты не говорят о токенах ни на одном языке', () => {
    for (const lang of LANGS) for (const kind of KINDS) {
      expect(chatFailureText(kind, lang, { storeBuild: true })).not.toMatch(MONEY);
      expect(chatFailureText(kind, lang, { storeBuild: true, upload: true })).not.toMatch(MONEY);
    }
  });

  it('обычный relayUpdating и cliFatal честно говорят, что не списано', () => {
    expect(chatFailureText('relayUpdating', 'ru')).toContain('Токены не списаны');
    expect(chatFailureText('cliFatal', 'en')).toContain('No tokens were charged');
  });

  it('загрузка просит прислать и файлы', () => {
    expect(chatFailureText('relayUpdating', 'ru', { upload: true })).toContain('файлы');
    expect(chatFailureText('relayUpdating', 'de', { upload: true })).toContain('Dateien');
  });

  it('не-русские тексты без кириллицы', () => {
    for (const lang of LANGS.filter((l) => l !== 'ru')) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(chatFailureText(kind, lang, v)).not.toMatch(/[а-яё]/i);
    }
  });

  it('неизвестный язык и пустой — русский', () => {
    expect(chatFailureText('noReply', 'xx')).toBe(chatFailureText('noReply', 'ru'));
    expect(chatFailureText('noReply', undefined)).toBe(chatFailureText('noReply', 'ru'));
    expect(chatFailureText('noReply', 'EN')).toBe(chatFailureText('noReply', 'en'));
  });

  it('ни один текст не принимается за сбой CLI или генерации', () => {
    const looksCliFailure = (t: string) => (ChatService.prototype as any).looksCliFailure.call({}, t);
    for (const t of allChatFailureTexts()) {
      expect(looksCliFailure(t)).toBe(false);
      expect(looksLikeFailure(t)).toBe(false);
    }
  });

  it('allChatFailureTexts — без повторов и с каждым вариантом', () => {
    const all = allChatFailureTexts();
    expect(new Set(all).size).toBe(all.length);
    for (const lang of LANGS) for (const kind of KINDS) for (const v of VARIANTS) {
      expect(all).toContain(chatFailureText(kind, lang, v));
    }
  });

  it('старые русские строки больше не зашиты в чат-сервис и контроллер', () => {
    for (const file of ['chat.service.ts', 'chat.controller.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toContain('Ошибка запуска агента');
      for (const t of allChatFailureTexts()) expect(src).not.toContain(`'${t}'`);
    }
  });
});
