import { products } from './articles/products';
import { renderArticle } from './render';
import { V } from './values';
import { DELETE_GRACE_DAYS } from '../products/product-actions.service';

/**
 * Справка о продуктах после того, как ассистент научился заводить, удалять и
 * возвращать их сам: прежний текст («в чате ассистент его не создаёт»,
 * «удалить — только через поддержку») прямо врал бы человеку.
 */
describe('справка о продуктах: ассистент ведёт продукт целиком', () => {
  const web = renderArticle(products, 'ru', 'web');

  it('завести, удалить и вернуть можно, попросив ассистента', () => {
    expect(web).not.toMatch(/ассистент его не создаёт/);
    expect(web).not.toMatch(/Удалить или переименовать продукт сам — только через поддержку/);
    expect(web).toMatch(/попросив ассистента/);
    expect(web).toMatch(/«Удалить»/);
  });

  it('срок возврата — из константы удаления', () => {
    expect(V.deleteGraceDays).toBe(String(DELETE_GRACE_DAYS));
    expect(web).toContain(`${V.deleteGraceDays} дней`);
  });

  it('ключи бота — только в защищённую карточку, не в переписку', () => {
    expect(web).toMatch(/защищённ\S* карточк/);
  });
});
