import { KB_ARTICLES } from './articles';
import { KB_CLIENTS } from './kb.types';
import { renderArticle } from './render';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * С 17.11.2026 оборванный ход списывается за то, что успело прийти
 * (src/chat/partial-billing.ts, решение владельца). По справке отвечают
 * ассистенты и ИИ-поддержка — обещать «оборванный ход бесплатен» она больше
 * не должна.
 */
const OLD_PROMISE = /оборванный ход не списывается|новым сообщением, не оплачивается/i;

describe('справка: оборванный ход', () => {
  it('ни в одном варианте статей нет обещания «оборванный ход бесплатен»', () => {
    const bad: string[] = [];
    for (const a of KB_ARTICLES) {
      for (const lang of SUPPORTED_LANGUAGES) {
        for (const client of KB_CLIENTS) {
          if (client === 'store' && a.paidOnly) continue;
          if (OLD_PROMISE.test(renderArticle(a, lang, client))) bad.push(`${a.id}/${lang}/${client}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('tokens и chat говорят, что за обрыв списывается сделанное', () => {
    const byId = (id: string) => KB_ARTICLES.find((a) => a.id === id)!;
    expect(renderArticle(byId('tokens'), 'ru', 'web')).toContain('оплачивается по сделанной работе');
    expect(renderArticle(byId('chat'), 'ru', 'web')).toContain('за обрыв списывается только сделанное');
  });
});
