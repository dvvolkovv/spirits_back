/**
 * Постоянная труппа роликов со сценками — паспорта героев.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Труппа».
 * Облик (`look`), голос (`voice`) и короткое имя в кадре (`who`) — по-английски:
 * из них код собирает промпты Nano Banana и Omni (short-skit-prompts.ts).
 * Роли, манера и коронные фразы — по-русски: их читают режиссёр и сценарист.
 * Портреты — studio/assets/troupe/<версия>/<id>.png, вырезаны из листа,
 * утверждённого владельцем 26.10.2026.
 *
 * Текст паспорта (голос, уточнение облика) правится на месте: отпечатки сценок
 * считаются от промптов, и сценки с новым текстом переснимутся сами. Новая
 * версия листа нужна, когда меняется картинка — новый герой или новый облик:
 * старые ролики остаются со своими портретами.
 */
export const TROUPE_VERSION = 'v1';

export type TroupeId = 'kesha' | 'galina' | 'boris' | 'mikhalych' | 'zhorik';

export interface Hero {
  id: TroupeId;
  /** Имя в подписях владельцу и в промптах режиссёра. */
  name: string;
  /** Кто это в кадре, коротко: им промпт Omni называет говорящего. */
  who: string;
  /**
   * Облик — совпадает с портретом: текст и картинка вместе уходят в Nano Banana.
   * Профессия — через зверя («a cat boss»), а не «a boss»: иначе генератор
   * дорисует отдельного человека.
   */
  look: string;
  /** Описание голоса для Omni: одно и то же в каждом промпте держит голос узнаваемым. */
  voice: string;
  manner: string;
  /** Правило 16: в сценке у героя роль только из этого списка. */
  roles: string[];
  catchphrases: string[];
}

export const TROUPE: readonly Hero[] = [
  {
    id: 'kesha',
    name: 'Капибара Кеша',
    who: 'the capybara',
    look: 'a brown capybara with a calm, slightly sleepy face, wearing a chunky beige knitted sweater',
    voice: 'soft, calm, unhurried mid-pitched male voice',
    manner: 'Главный герой, «обычный человек». Невозмутим, сколько бы на него ни кричали. Не спорит и не паникует — спрашивает ассистента.',
    roles: ['жилец', 'работник', 'покупатель', 'клиент', 'сосед', 'муж', 'предприниматель', 'заёмщик'],
    catchphrases: ['Спокойно. Сейчас спрошу.'],
  },
  {
    id: 'galina',
    name: 'Гусыня Галина Петровна',
    who: 'the goose',
    look: 'a white goose with an orange beak and orange feet, a grumpy elderly goose lady wearing a cream apron with a pink rose print, holding a bunch of keys',
    voice: 'shrill, loud, grumpy elderly female voice',
    manner: 'Вечный противник. Скандалит, шипит, машет крыльями, тычет крылом в «улики». В развязке сдаётся.',
    roles: ['хозяйка квартиры', 'соседка', 'свекровь', 'вахтёрша', 'продавщица'],
    catchphrases: ['Га-га… ладно.'],
  },
  {
    id: 'boris',
    name: 'Кот Борис Аркадьевич',
    who: 'the cat',
    look: 'a fat grey tabby cat with yellow eyes, a pompous cat boss wearing a too-tight navy suit, white shirt and striped tie, holding a rubber stamp with a wooden handle',
    voice: 'booming, lazy, pompous bass voice',
    manner: 'Начальник. Важный и ленивый, всё «не положено». Ставит печать — и засыпает.',
    roles: ['работодатель', 'начальник', 'чиновник', 'налоговая', 'управляющая компания'],
    catchphrases: ['Не положено.'],
  },
  {
    id: 'mikhalych',
    name: 'Бобр Михалыч',
    who: 'the beaver',
    look: 'a brown beaver with big front teeth, a beaver handyman wearing blue denim overalls with a leather tool belt and a pencil behind his ear',
    voice: 'hoarse, cheerful middle-aged male voice',
    manner: 'Мастер. Работяга, вечно всё переделывает, смета растёт на глазах.',
    roles: ['подрядчик', 'сантехник', 'автосервис', 'строитель', 'мастер'],
    catchphrases: ['Тут всё переделывать, хозяин.'],
  },
  {
    id: 'zhorik',
    name: 'Енот Жорик',
    who: 'the raccoon',
    look: 'a raccoon with a sly grin, a raccoon salesman wearing a brown checkered jacket, white shirt and a gold chain',
    voice: 'fast-talking, slick, ingratiating male voice',
    manner: 'Хитрый продавец. Говорит быстро, обещает золотые горы, мелкий шрифт прячет.',
    roles: ['продавец', 'кредитный менеджер', 'мошенник по телефону', 'турагент', 'риелтор'],
    catchphrases: ['Только сегодня, только для вас!'],
  },
];

export function heroById(id: string): Hero | undefined {
  return TROUPE.find((h) => h.id === id);
}
