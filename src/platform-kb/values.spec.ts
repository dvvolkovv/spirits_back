import { fmt, V } from './values';
import { IMAGE_TOKENS_HD, IMAGE_TOKENS_STD } from '../misc/image-pricing';
import { FREE_MONTH_PRODUCTS, RENT_TOKENS } from '../products/rent.service';
import { WELCOME_BONUS } from '../identity/identity.service';
import { REFEREE_BONUS_TOKENS } from '../referral/referral.service';
import { computeVeoQuote } from '../video/video.dto';
import { LIMITS } from '../peer/peer.dto';

describe('числа справки — из констант', () => {
  it('fmt: пробел между тысячами', () => {
    expect(fmt(25000)).toBe('25 000');
    expect(fmt(1000000)).toBe('1 000 000');
    expect(fmt(500)).toBe('500');
  });

  it('цены и лимиты совпадают с константами списания и проверок', () => {
    expect(V.imageStd).toBe(fmt(IMAGE_TOKENS_STD));
    expect(V.imageHd).toBe(fmt(IMAGE_TOKENS_HD));
    expect(V.rentTokens).toBe(fmt(RENT_TOKENS));
    expect(V.freeMonthProducts).toBe(String(FREE_MONTH_PRODUCTS));
    expect(V.welcomeBonus).toBe(fmt(WELCOME_BONUS));
    expect(V.refereeBonus).toBe(fmt(REFEREE_BONUS_TOKENS));
    expect(V.introMax).toBe(fmt(LIMITS.INTRO_MAX));
  });

  it('цены видео посчитаны функцией котировки', () => {
    expect(V.videoPriceLines).toContain(fmt(computeVeoQuote('veo-3.1-fast', 8).totalCost));
    expect(V.videoPriceLines.split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('комиссия партнёров — все ступени по возрастанию', () => {
    expect(V.commissionTiers).toMatch(/^\d+% — пока оплативших друзей меньше \d+; /);
  });

  it('каждое значение — непустая строка без undefined и NaN', () => {
    for (const v of Object.values(V)) {
      expect(typeof v).toBe('string');
      expect(v.trim()).not.toBe('');
      expect(v).not.toMatch(/undefined|NaN/);
    }
  });
});
