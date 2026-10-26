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

  it('оба пути забирают карточки своего хода', () => {
    expect(SRC.match(/productActions\?\.takeForTurn\(/g)?.length).toBe(2);
  });

  it('ProductsModule подключён к ChatModule — иначе @Optional молча выключит карточки', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule)).toContain(ProductsModule);
  });
});
