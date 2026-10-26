import * as fs from 'fs';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { parseClientUi } from './client-ui';
import { ChatModule } from './chat.module';
import { ProductsModule } from '../products/products.module';

const SRC = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');

describe('карточки продуктов в ходе чата', () => {
  it('клиент объявляет карточки полем ui.cards, только строгим true', () => {
    expect(parseClientUi({ activity: true, ask: true, cards: true }).cards).toBe(true);
    expect(parseClientUi({ cards: 'yes' }).cards).toBe(false);
    expect(parseClientUi('{"cards":true}').cards).toBe(true);
  });

  it('метка хода уходит в токен и релея, и Маши', () => {
    expect(SRC).toContain('productsRelayFields(userId, productsTurn)');
    expect(SRC).toContain("productsCliMcp(userId, 'web', productsTurn)");
  });

  // Было 2 (релей, Маша) до ревью задачи 11. Третий — в catch-ветке релея:
  // апстрим может порваться ПОСЛЕ того, как модель дёрнула инструмент
  // продуктов, но до чистого конца потока, — без своего takeForTurn там
  // карточка терялась бы навсегда (под тем же productsTurn её больше никто
  // не спросит). Задвоения не бывает: takeForTurn помечает attached_at, и
  // второй вызов тем же nonce (обычная ветка уже забрала) вернёт [].
  it('карточки своего хода забирают три места: релей (успех и catch) и Маша', () => {
    expect(SRC.match(/productActions\?\.takeForTurn\(/g)?.length).toBe(3);
  });

  it('ProductsModule подключён к ChatModule — иначе @Optional молча выключит карточки', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule)).toContain(ProductsModule);
  });
});
