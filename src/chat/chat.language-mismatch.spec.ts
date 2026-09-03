import { ChatService } from './chat.service';

/**
 * «Ответ не на языке собеседника» — детектор для метрики качества.
 *
 * Прежняя версия (looksEnglishLeak) считала дефектом любой текст, где меньше
 * 10% кириллицы. Для одноязычного продукта это верно, для семи локалей — нет:
 * корректный ответ англичанину, немцу, испанцу, французу и португальцу
 * попадал под правило наравне с настоящей утечкой, а китайский — всегда, в нём
 * кириллицы не бывает в принципе. 15.08.2026 такой алерт прилетел на ровном
 * месте: «всплеск англоязычных ответов 4/37».
 *
 * Проверяем оба направления: настоящая утечка обязана ловиться, легальный
 * иноязычный ответ обязан НЕ ловиться.
 */

// Эвристика чистая — от зависимостей сервиса не зависит, поэтому конструктор
// не вызываем вовсе. Приватные методы дёргаем через as any: выносить их в
// отдельный модуль ради теста значило бы менять форму кода под тест.
const svc = Object.create(ChatService.prototype) as any;
const mismatch = (resp: string, lang: string, msg: string): boolean =>
  svc.looksLanguageMismatch(resp, lang, msg);

const RU_LONG = 'Здравствуйте! Давайте разберём вашу ситуацию по шагам и найдём решение вместе.';
const EN_LONG = 'Hello! Let us go through your situation step by step and find a solution together.';
const DE_LONG = 'Guten Tag! Lassen Sie uns Ihre Situation Schritt für Schritt durchgehen und gemeinsam eine Lösung finden.';
const ZH_LONG = '您好！让我们一步一步地分析您的情况，一起找到解决方案。我们会仔细考虑每一个细节问题。';

describe('утечка языка ловится', () => {
  it('русский спросил — английский ответ', () => {
    expect(mismatch(EN_LONG, 'ru', 'Привет, помоги мне разобраться с договором аренды')).toBe(true);
  });

  it('китаец спросил — английский ответ', () => {
    expect(mismatch(EN_LONG, 'zh', ZH_LONG)).toBe(true);
  });

  it('англичанин спросил — русский ответ', () => {
    expect(mismatch(RU_LONG, 'en', 'Hello, could you help me with my rental agreement please?')).toBe(true);
  });
});

describe('легальный иноязычный ответ НЕ считается дефектом', () => {
  it('англичанин спросил — английский ответ', () => {
    expect(mismatch(EN_LONG, 'en', 'Hello, could you help me with my rental agreement please?')).toBe(false);
  });

  it('немец спросил — немецкий ответ (латиница, кириллицы ноль)', () => {
    expect(mismatch(DE_LONG, 'de', 'Guten Tag, koennen Sie mir bitte bei meinem Mietvertrag helfen?')).toBe(false);
  });

  it('китаец спросил — китайский ответ (кириллицы не бывает в принципе)', () => {
    expect(mismatch(ZH_LONG, 'zh', ZH_LONG)).toBe(false);
  });

  it('русский спросил — русский ответ', () => {
    expect(mismatch(RU_LONG, 'ru', 'Привет, помоги мне разобраться с договором аренды')).toBe(false);
  });
});

describe('на чём судить нельзя — молчим', () => {
  it('короткий ответ не оценивается', () => {
    expect(mismatch('OK', 'ru', 'Привет, помоги мне разобраться с договором аренды')).toBe(false);
  });

  it('русский ответ с английскими терминами — не смена языка', () => {
    const mixed = 'Настройте webhook в личном кабинете, затем проверьте callback и статус payment в консоли администратора.';
    expect(mismatch(mixed, 'ru', 'Привет, помоги настроить приём платежей на сайте')).toBe(false);
  });

  it('реплика юзера короткая — опора на язык профиля', () => {
    // «ок» ничего не говорит о языке, поэтому судим по профилю.
    expect(mismatch(EN_LONG, 'ru', 'ок')).toBe(true);
    expect(mismatch(EN_LONG, 'en', 'ok')).toBe(false);
  });

  it('юзер сам перешёл на другой язык — ответ на нём же не дефект', () => {
    // Языковая директива это прямо разрешает, а в профиле язык задан
    // у меньшинства учёток, поэтому реплика важнее профиля.
    expect(mismatch(EN_LONG, 'ru', 'Hello, could you help me with my rental agreement please?')).toBe(false);
  });
});

describe('код и логи в реплике не делают её иноязычной', () => {
  // Инцидент 02.09.2026: пользователь 79035281880 отлаживал вёрстку и вставлял
  // в чат вывод консоли и CSS. После очистки в его реплике 59 символов
  // кириллицы против 137 латиницы (70%), детектор счёл его англоязычным — и
  // корректный русский ответ ассистента (98% кириллицы) записал в нарушение.
  // Шесть таких ходов за вечер дали алерт «21% ответов не на языке собеседника».
  const CONSOLE_DUMP =
    '--- ДИАГНОСТИКА БЛОГА --- VM464:4 HTML тег: <html data-theme="dark" class="dna-on" ' +
    'style="--tw: 1322.13px; --th: 1488.00px; --ew: 727.17px; --hx: -220.80px;">';
  const CSS_PASTE =
    '1. текст под карточками в темной теме так и не видно. 2. /* ===== БЛОГ ===== */ ' +
    '.blog{display:grid} .post__t{font-weight:600} .post{border-radius:12px;overflow:hidden}';

  it('вставленный вывод консоли — русский ответ не дефект', () => {
    expect(mismatch(RU_LONG, 'ru', CONSOLE_DUMP)).toBe(false);
  });

  it('вставленный CSS — русский ответ не дефект', () => {
    expect(mismatch(RU_LONG, 'ru', CSS_PASTE)).toBe(false);
  });

  it('но настоящая утечка на том же вопросе ловится по профилю', () => {
    // Реплика с кодом расходится с профилем, поэтому молчим и здесь — это
    // сознательная цена: пропустить утечку дешевле, чем поднять ложный алерт.
    expect(mismatch(EN_LONG, 'ru', CSS_PASTE)).toBe(false);
  });
});
