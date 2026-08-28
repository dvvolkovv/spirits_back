/**
 * Окончания, с которыми имя остаётся обращением.
 *
 * Список закрытый, а не «имя плюс до трёх букв»: свободный хвост превращает
 * «Роман» в «романтику», а «Анну» в «аннотацию» — то есть ассистент влезал бы
 * в чужой разговор, не будучи позванным. Ложное молчание дешевле ложной
 * реплики при клиенте.
 */
const ENDINGS = ['', 'а', 'у', 'е', 'ы', 'и', 'ом', 'ой', 'ей', 'ю', 'я', 'ье', 'ем'];

/** «Роман, пока слушай» и синонимы. */
const LISTEN_CMD = /(пока\s+слушай|просто\s+слушай|молчи|в\s+режим\w*\s+слушател)/i;

/** «Роман, вопрос к тебе» и синонимы. */
const RESUME_CMD = /(вопрос\s+к\s+тебе|можешь\s+говорить|возвращайся|подключайся|включайся)/i;

/** Что делать с репликой, которую только что распознали. */
export type GateDecision =
  /** промолчать */
  | 'silent'
  /** дать модели ход */
  | 'respond'
  /** подтвердить уход в режим слушателя одной фразой */
  | 'ack_listen'
  /** подтвердить возвращение в диалог одной фразой */
  | 'ack_resume';

function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е');
}

/**
 * Основа имени для склонения: у имён на гласную она без неё (Анна → анн),
 * у остальных — само имя (Роман → роман).
 */
function stemOf(name: string): string {
  const n = normalize(name).trim();
  return /[аеиоуыэюя]$/.test(n) ? n.slice(0, -1) : n;
}

/** Прозвучало ли в реплике обращение к ассистенту с этим именем. */
export function addressedByName(text: string, name: string): boolean {
  const stem = stemOf(name);
  if (!stem) return false;
  return normalize(text)
    .split(/[^a-zа-я0-9]+/)
    .filter(Boolean)
    .some((w) => w.startsWith(stem) && ENDINGS.includes(w.slice(stem.length)));
}

/**
 * Когда ассистенту позволено говорить на встрече.
 *
 * По умолчанию молчит. Отвечает, если назвали по имени, и дальше некоторое
 * время отвечает без имени: иначе доспросить его «а почему?» было бы
 * невозможно, пришлось бы звать заново на каждую фразу.
 *
 * Окно продолжения открывает ФАКТ ответа (noteReplied), а не факт обращения.
 * Если модель промолчала — разговора нет, и продолжать нечего.
 *
 * Поверх этого — режим слушателя по голосовой команде. Команды распознаются
 * ТОЛЬКО вместе с именем: «вопрос к тебе», сказанное одним живым участником
 * другому, не должно возвращать в разговор ассистента, которого оттуда
 * специально убрали.
 */
export class NameGate {
  private openUntil = 0;
  private muted = false;

  constructor(
    private readonly name: string,
    private readonly windowMs: number,
  ) {}

  decide(text: string, now: number): GateDecision {
    const addressed = addressedByName(text, this.name);

    if (addressed && LISTEN_CMD.test(text)) {
      this.muted = true;
      // Окно тоже гасим: без этого следующая реплика прошла бы по нему, и
      // режим слушателя включился бы с задержкой в полминуты.
      this.openUntil = 0;
      return 'ack_listen';
    }

    // Обратная команда работает только из режима слушателя. Иначе обычное
    // «Роман, вопрос к тебе» превращалось бы в подтверждение вместо ответа.
    if (this.muted && addressed && RESUME_CMD.test(text)) {
      this.muted = false;
      return 'ack_resume';
    }

    if (this.muted) return 'silent';
    if (addressed) return 'respond';
    return now < this.openUntil ? 'respond' : 'silent';
  }

  /** Ассистент закончил реплику — окно продолжения продлевается. */
  noteReplied(now: number): void {
    if (!this.muted) this.openUntil = now + this.windowMs;
  }
}
