import { EventEmitter } from 'events';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { SpeechkitSttService, SPEECHKIT_LANGUAGE_CODES, isSttLanguageSupported } from './speechkit-stt.service';

/// Диктовка слушала только ru-RU: человек с английским, испанским или
/// немецким профилем получал вместо своих слов русскую кашу. Теперь язык
/// распознавания берётся из профиля, а языка без поддержки SpeechKit
/// диктовка не открывает вовсе.
describe('SpeechKit: язык распознавания', () => {
  it('карта языков Linkeon → SpeechKit; португальский — европейский', () => {
    expect(SPEECHKIT_LANGUAGE_CODES).toEqual({
      ru: 'ru-RU',
      en: 'en-US',
      de: 'de-DE',
      es: 'es-ES',
      fr: 'fr-FR',
      pt: 'pt-PT',
    });
  });

  it('из языков Linkeon без диктовки только китайский: у SpeechKit v3 его нет', () => {
    // Новый язык в SUPPORTED_LANGUAGES уронит этот тест — решать про
    // диктовку для него надо осознанно, а не молчаливым ru-RU.
    expect(SUPPORTED_LANGUAGES.filter((l) => !isSttLanguageSupported(l))).toEqual(['zh']);
  });

  it('незнакомый, пустой и полный тег — не поддерживаются: на вход ждём корень языка', () => {
    expect(isSttLanguageSupported('xx')).toBe(false);
    expect(isSttLanguageSupported('')).toBe(false);
    expect(isSttLanguageSupported(undefined)).toBe(false);
    expect(isSttLanguageSupported('en-US')).toBe(false);
    expect(isSttLanguageSupported('constructor')).toBe(false);
  });
});

describe('SpeechKit: опции сессии', () => {
  const OLD_KEY = process.env.YANDEX_SPEECHKIT_API_KEY;
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.YANDEX_SPEECHKIT_API_KEY;
    else process.env.YANDEX_SPEECHKIT_API_KEY = OLD_KEY;
  });

  /** Сервис с подменённым gRPC-клиентом: копит всё, что пишется в стрим. */
  function makeService() {
    process.env.YANDEX_SPEECHKIT_API_KEY = 'test-key';
    const writes: any[] = [];
    let created = 0;
    class FakeRecognizer {
      constructor() { created += 1; }
      RecognizeStreaming() {
        const call: any = new EventEmitter();
        call.write = (msg: any) => { writes.push(msg); return true; };
        call.end = () => {};
        return call;
      }
      close() {}
    }
    const service = new SpeechkitSttService();
    (service as any).RecognizerCtor = FakeRecognizer;
    return { service, writes, created: () => created };
  }

  const callbacks = () => ({ onPartial: jest.fn(), onFinal: jest.fn(), onError: jest.fn(), onEnd: jest.fn() });

  it.each([
    ['en', 'en-US'],
    ['de', 'de-DE'],
    ['es', 'es-ES'],
    ['fr', 'fr-FR'],
    ['pt', 'pt-PT'],
    ['ru', 'ru-RU'],
  ])('язык %s → language_code %s в первом сообщении стрима', (lang, code) => {
    const { service, writes } = makeService();
    const cb = callbacks();
    service.openStream(cb, lang);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(writes[0].session_options.recognition_model.language_restriction).toEqual({
      restriction_type: 'WHITELIST',
      language_code: [code],
    });
  });

  it('язык не передан — русский, как раньше', () => {
    const { service, writes } = makeService();
    service.openStream(callbacks());
    expect(writes[0].session_options.recognition_model.language_restriction.language_code).toEqual(['ru-RU']);
  });

  it('неподдерживаемый язык — ошибка, gRPC-клиент не создаётся и в Яндекс ничего не уходит', () => {
    const { service, writes, created } = makeService();
    const cb = callbacks();
    const handle = service.openStream(cb, 'zh');
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(created()).toBe(0);
    handle.push(Buffer.from([1, 2]));
    handle.end();
    expect(writes).toEqual([]);
  });
});
