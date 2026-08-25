import * as crypto from 'crypto';
import { verifyInitData } from './init-data';

const BOT_TOKEN = '123456:TEST-TOKEN-AAAA';
const OTHER_BOT_TOKEN = '999999:OTHER-TOKEN-BBBB';

/** Собирает валидно подписанную строку initData — как её отдаёт Telegram. */
function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

const nowSec = () => Math.floor(Date.now() / 1000);

const validFields = (overrides: Record<string, string> = {}) => ({
  auth_date: String(nowSec()),
  query_id: 'AAEtest',
  user: JSON.stringify({ id: 42, first_name: 'Дмитрий', username: 'dv' }),
  ...overrides,
});

describe('verifyInitData — негативные случаи', () => {
  it('отвергает подменённый hash', () => {
    const raw = signInitData(validFields());
    const tampered = raw.replace(/hash=[0-9a-f]+/, 'hash=' + 'd'.repeat(64));
    expect(verifyInitData(tampered, BOT_TOKEN)).toBeNull();
  });

  it('отвергает подменённое поле user при исходном hash', () => {
    const raw = signInitData(validFields());
    const params = new URLSearchParams(raw);
    params.set('user', JSON.stringify({ id: 999, first_name: 'Чужой' }));
    expect(verifyInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });

  it('отвергает просроченный auth_date', () => {
    const old = String(nowSec() - 25 * 60 * 60);
    const raw = signInitData(validFields({ auth_date: old }));
    expect(verifyInitData(raw, BOT_TOKEN)).toBeNull();
  });

  it('отвергает пустую строку', () => {
    expect(verifyInitData('', BOT_TOKEN)).toBeNull();
  });

  it('отвергает строку без hash', () => {
    const params = new URLSearchParams(validFields());
    expect(verifyInitData(params.toString(), BOT_TOKEN)).toBeNull();
  });

  it('отвергает подпись другого бота', () => {
    const raw = signInitData(validFields(), OTHER_BOT_TOKEN);
    expect(verifyInitData(raw, BOT_TOKEN)).toBeNull();
  });

  it('отвергает initData без поля user', () => {
    const fields = validFields();
    delete (fields as any).user;
    const raw = signInitData(fields);
    expect(verifyInitData(raw, BOT_TOKEN)).toBeNull();
  });

  it('отвергает user с нечисловым id', () => {
    const raw = signInitData(validFields({ user: JSON.stringify({ id: 'abc', first_name: 'X' }) }));
    expect(verifyInitData(raw, BOT_TOKEN)).toBeNull();
  });
});

describe('verifyInitData — валидный случай', () => {
  it('принимает свежую корректную подпись и возвращает пользователя', () => {
    const raw = signInitData(validFields());
    expect(verifyInitData(raw, BOT_TOKEN)).toEqual({
      tgUserId: 42,
      tgUsername: 'dv',
      tgFirstName: 'Дмитрий',
    });
  });

  it('отдаёт null в username, когда его нет', () => {
    const raw = signInitData(validFields({ user: JSON.stringify({ id: 7, first_name: 'A' }) }));
    expect(verifyInitData(raw, BOT_TOKEN)).toEqual({
      tgUserId: 7,
      tgUsername: null,
      tgFirstName: 'A',
    });
  });
});
