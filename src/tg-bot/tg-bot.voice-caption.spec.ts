import { TgBotService } from './tg-bot.service';

/**
 * Голосовой ответ обрезал текст.
 *
 * Жалоба владельца 22.08.2026: «голосом читает полностью, а текст обрезает».
 * TTS синтезировал весь ответ, а подпись к голосовому уходила как
 * substring(0, 1024) — молча, без продолжения. Нарезка splitForTelegram этот
 * путь не прикрывала: она живёт в sendMessage, а голос идёт через sendVoice,
 * и лимит подписи к медиа — 1024, а не 4096.
 */

const LIMIT = TgBotService.VOICE_CAPTION_LIMIT;

describe('TgBotService.voiceCaptionPlan', () => {
  it('короткий ответ целиком уходит в подпись — одно сообщение, как раньше', () => {
    const plan = TgBotService.voiceCaptionPlan('короткий ответ');

    expect(plan).toEqual({ caption: 'короткий ответ', needsSeparateText: false });
  });

  it('ровно на лимите ещё помещается в подпись', () => {
    const text = 'я'.repeat(LIMIT);

    const plan = TgBotService.voiceCaptionPlan(text);

    expect(plan.caption).toHaveLength(LIMIT);
    expect(plan.needsSeparateText).toBe(false);
  });

  it('длинный ответ не режется в подпись, а уходит отдельным текстом', () => {
    const text = 'я'.repeat(LIMIT + 1);

    const plan = TgBotService.voiceCaptionPlan(text);

    // Главное: НЕТ обрезанной подписи. Раньше сюда попадал огрызок в 1024.
    expect(plan.caption).toBeUndefined();
    expect(plan.needsSeparateText).toBe(true);
  });

  it('ничего не теряет: подпись либо равна тексту, либо текста в ней нет вовсе', () => {
    for (const len of [1, LIMIT - 1, LIMIT, LIMIT + 1, LIMIT * 4]) {
      const text = 'x'.repeat(len);
      const plan = TgBotService.voiceCaptionPlan(text);

      if (plan.caption !== undefined) expect(plan.caption).toBe(text);
      else expect(plan.needsSeparateText).toBe(true);
    }
  });
});
