// @ts-check
// Проверяет d0fbc717-фикс: deep-link ?say=<text>&assistant=roman → выбирается универсальный
// Роман И текст РЕАЛЬНО отправляется (а не теряется в пустом поле). Run: как smoke.
const { test, expect } = require('@playwright/test');
const axios = require('axios');

const BASE = process.env.BASE_URL || 'https://my.linkeon.io';
const TEST_PHONE = process.env.TEST_PHONE || '70000000000';

async function getJwt() {
  await axios.get(`${BASE}/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/${TEST_PHONE}`);
  const code = (await axios.get(`${BASE}/webhook/debug/sms-code/${TEST_PHONE}`)).data.code;
  const r = await axios.get(`${BASE}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${TEST_PHONE}/${code}`);
  return { access: r.data['access-token'], refresh: r.data['refresh-token'] };
}

test('quick-ask: ?say=+assistant=roman → Роман выбран и текст отправлен', async ({ page }) => {
  const { access, refresh } = await getJwt();
  const agents = (await axios.get(`${BASE}/webhook/agents`)).data;
  const raya = agents.find((a) => a.name === 'Райя'); // полный объект — иначе UI падает на missing-полях
  await page.addInitScript(([a, r, u, rayaObj]) => {
    localStorage.setItem('jwt_access_token', a);
    localStorage.setItem('jwt_refresh_token', r);
    localStorage.setItem('authToken', a);
    localStorage.setItem('userData', u);
    // ТЁПЛЫЙ старт — уже выбран ДРУГОЙ ассистент (как у owner была Райя)
    if (rayaObj) sessionStorage.setItem('selected_assistant', rayaObj);
  }, [access, refresh, JSON.stringify({ phone: TEST_PHONE }), raya ? JSON.stringify(raya) : '']);

  const QUERY = 'посоветуй уходовую косметику для сухой кожи';
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(BASE + '/chat?say=' + encodeURIComponent(QUERY) + '&assistant=roman', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  const inputVal = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta ? ta.value : '(no textarea)';
  });
  const selAsst = await page.evaluate(() => sessionStorage.getItem('selected_assistant'));
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

  // 1) текст РЕАЛЬНО отправлен (появился в чате пузырём), а НЕ утрачен в пустом поле
  expect(body).toContain(QUERY.slice(0, 25));
  // 2) поле ввода пустое — текст ушёл в отправку, не завис в textarea
  expect(inputVal.trim()).toBe('');
  // 3) выбран УНИВЕРСАЛЬНЫЙ Роман (id 12), а не «тёплый» последний (Райя id 14)
  const sel = JSON.parse(selAsst || '{}');
  expect(sel.id).toBe(12);
  expect(logs.join(' ')).not.toContain('signal');
});
