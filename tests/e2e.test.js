/**
 * E2E Tests for NestJS backend on 82.202.197.230
 * Uses debug/sms-code endpoint instead of n8n API
 */

const axios = require('axios');
const config = require('./config');

const BASE = config.BASE_URL;
const TEST_PHONE = config.TEST_PHONE || '79169403771';
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

const http = axios.create({
  baseURL: BASE,
  timeout: 90000,
  validateStatus: () => true,
});

const auth = { access: null, refresh: null, userId: TEST_PHONE };

function headers() {
  return { headers: { Authorization: `Bearer ${auth.access}` } };
}

async function loginWithOtp() {
  await http.get(`/webhook/${SMS_WH}/sms/${TEST_PHONE}`);
  await new Promise(r => setTimeout(r, 1000));
  const codeResp = await http.get(`/webhook/debug/sms-code/${TEST_PHONE}`);
  if (!codeResp.data.code) throw new Error(`No code: ${JSON.stringify(codeResp.data)}`);
  const resp = await http.get(`/webhook/${CHECK_WH}/check-code/${TEST_PHONE}/${codeResp.data.code}`);
  if (!resp.data['access-token']) throw new Error(`Login failed: ${JSON.stringify(resp.data)}`);
  auth.access = resp.data['access-token'];
  auth.refresh = resp.data['refresh-token'];
}

function parseChatStream(rawData) {
  if (typeof rawData !== 'string') rawData = JSON.stringify(rawData);
  const lines = rawData.split('\n').filter(l => l.trim());
  const result = { begin: false, end: false, chunks: [], fullText: '' };
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'begin') result.begin = true;
      if (obj.type === 'item' && obj.content) result.chunks.push(obj.content);
      if (obj.type === 'end') { result.end = true; result.fullText = result.chunks.join(''); }
    } catch (e) {}
  }
  if (!result.fullText && result.chunks.length > 0) result.fullText = result.chunks.join('');
  return result;
}

module.exports = {
  'AUTH: SMS OTP login — получаем JWT токены': async () => {
    await loginWithOtp();
    if (!auth.access) throw new Error('access-token отсутствует');
    if (!auth.refresh) throw new Error('refresh-token отсутствует');
    if (auth.access.split('.').length !== 3) throw new Error('access-token не JWT');
  },

  'AUTH: refresh token — получаем новые токены': async () => {
    const resp = await http.post('/webhook/auth/refresh', {}, {
      headers: { Authorization: `Bearer ${auth.refresh}` }
    });
    if (resp.status !== 200) throw new Error(`Refresh failed: ${resp.status}`);
    if (!resp.data['access-token']) throw new Error('Нет access-token');
    if (!resp.data['refresh-token']) throw new Error('Нет refresh-token');
    auth.access = resp.data['access-token'];
    auth.refresh = resp.data['refresh-token'];
  },

  'PROFILE: GET /webhook/profile — возвращает профиль': async () => {
    const resp = await http.get('/webhook/profile', headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
    if (!Array.isArray(resp.data) || !resp.data[0]?.profileJson) throw new Error('Нет profileJson');
    const p = resp.data[0].profileJson;
    if (!p.user_id) throw new Error('Нет user_id');
    if (typeof p.tokens === 'undefined') throw new Error('Нет tokens');
  },

  'PROFILE: данные профиля корректны': async () => {
    const resp = await http.get('/webhook/profile', headers());
    const p = resp.data[0].profileJson;
    if (p.user_id !== TEST_PHONE) throw new Error(`user_id=${p.user_id}, ожидался ${TEST_PHONE}`);
    if (typeof p.isadmin !== 'boolean') throw new Error('isadmin не boolean');
  },

  'PROFILE: GET /webhook/user/tokens/ — баланс токенов': async () => {
    const resp = await http.get('/webhook/user/tokens/', headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
    if (resp.data.success !== true) throw new Error('success !== true');
    if (typeof resp.data.tokens !== 'number') throw new Error(`tokens не число: ${resp.data.tokens}`);
  },

  'AGENTS: GET /webhook/agent-details — список ассистентов': async () => {
    const resp = await http.get('/webhook/agent-details', headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
    if (!Array.isArray(resp.data) || resp.data.length === 0) throw new Error('Пустой массив');
    if (!resp.data[0].id || !resp.data[0].name || !resp.data[0].system_prompt) throw new Error('Неполный агент');
    auth.testAgentId = String(resp.data[0].id);
    auth.testAgentName = resp.data[0].name;
  },

  'AGENTS: минимум 5 ассистентов': async () => {
    const resp = await http.get('/webhook/agent-details', headers());
    if (resp.data.length < 5) throw new Error(`${resp.data.length} < 5`);
  },

  'CHAT: стриминг ответ от ассистента': async () => {
    const resp = await http.post('/webhook/soulmate/chat', {
      message: 'Привет! Ответь одним коротким словом.',
      assistantId: auth.testAgentId || '3',
      sessionId: `e2e-${Date.now()}`,
    }, headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
    const s = parseChatStream(resp.data);
    if (!s.begin) throw new Error('Нет type:"begin"');
    if (!s.end) throw new Error('Нет type:"end"');
    if (s.chunks.length === 0) throw new Error('Нет chunks');
    if (!s.fullText.trim()) throw new Error('Пустой ответ');
    auth.lastChatResponse = s.fullText;
    console.log(`\n    [${auth.testAgentName}]: "${s.fullText.slice(0, 100)}..."`);
  },

  'CHAT: ответ не пустой': async () => {
    if (!auth.lastChatResponse || auth.lastChatResponse.trim().length < 2) {
      throw new Error(`Короткий ответ: "${auth.lastChatResponse}"`);
    }
  },

  'CHAT: разные ассистенты отвечают': async () => {
    const agents = (await http.get('/webhook/agent-details', headers())).data;
    const agent2 = agents.find(a => String(a.id) !== auth.testAgentId) || agents[1];
    const resp = await http.post('/webhook/soulmate/chat', {
      message: 'Как тебя зовут? Одно предложение.',
      assistantId: String(agent2.id),
      sessionId: `e2e-a2-${Date.now()}`,
    }, headers());
    const s = parseChatStream(resp.data);
    if (!s.fullText.trim()) throw new Error(`Пустой ответ от ${agent2.name}`);
    console.log(`\n    [${agent2.name}]: "${s.fullText.slice(0, 80)}..."`);
  },

  'HISTORY: возвращает историю чата': async () => {
    const resp = await http.get(`/webhook/chat/history?assistantId=${auth.testAgentId || '3'}`, headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
    if (!resp.data.messages || !Array.isArray(resp.data.messages)) throw new Error('Нет messages');
  },

  'HISTORY: корректная структура сообщений': async () => {
    const resp = await http.get(`/webhook/chat/history?assistantId=${auth.testAgentId || '3'}`, headers());
    const msgs = resp.data.messages;
    if (msgs.length === 0) throw new Error('История пуста');
    const msg = msgs[0];
    if (!msg.id) throw new Error('Нет id');
    if (!['user', 'assistant'].includes(msg.type)) throw new Error(`type: ${msg.type}`);
    if (!msg.content) throw new Error('Нет content');
  },

  'AGENT: смена предпочтительного ассистента': async () => {
    const before = (await http.get('/webhook/profile', headers())).data[0].profileJson.preferred_agent;
    const agents = (await http.get('/webhook/agent-details', headers())).data;
    const newA = agents.find(a => a.name !== before) || agents[1];
    const r = await http.post('/webhook/change-agent', { agent: newA.name }, headers());
    if (r.status !== 200) throw new Error(`Status ${r.status}`);
    const after = (await http.get('/webhook/profile', headers())).data[0].profileJson.preferred_agent;
    if (after !== newA.name) throw new Error(`Не изменился: ${after} != ${newA.name}`);
    console.log(`\n    "${before}" → "${after}"`);
    if (before) await http.post('/webhook/change-agent', { agent: before }, headers());
  },

  'PROFILE: обновление email': async () => {
    const resp = await http.post('/webhook/set-email', { email: 'test@test.com' }, headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
  },

  'PROFILE: обновление профиля': async () => {
    const resp = await http.post('/webhook/profile-update', { family_name: 'Тест' }, headers());
    if (resp.status !== 200) throw new Error(`Status ${resp.status}`);
  },

  'AVATAR: GET /webhook/avatar': async () => {
    const resp = await http.get('/webhook/avatar', headers());
    if (![200, 404].includes(resp.status)) throw new Error(`Status ${resp.status}`);
  },

  'REFERRAL: GET /webhook/referral/stats': async () => {
    const resp = await http.get('/webhook/referral/stats', headers());
    if (![200, 404].includes(resp.status)) throw new Error(`Status ${resp.status}`);
  },

  'E2E FLOW: логин → чат → история → профиль': async () => {
    await loginWithOtp();
    const profile = (await http.get('/webhook/profile', headers())).data[0]?.profileJson;
    if (!profile?.user_id) throw new Error('Нет профиля');
    const agents = (await http.get('/webhook/agent-details', headers())).data;
    if (!agents.length) throw new Error('Нет агентов');
    const chat = await http.post('/webhook/soulmate/chat', {
      message: 'Скажи "тест пройден".',
      assistantId: String(agents[0].id),
      sessionId: `e2e-flow-${Date.now()}`,
    }, headers());
    const s = parseChatStream(chat.data);
    if (!s.fullText) throw new Error('Пустой чат');
    await new Promise(r => setTimeout(r, 1500));
    const hist = await http.get(`/webhook/chat/history?assistantId=${agents[0].id}`, headers());
    if (!hist.data.messages?.length) throw new Error('Пустая история');
    const tok = await http.get('/webhook/user/tokens/', headers());
    if (typeof tok.data.tokens !== 'number') throw new Error('Нет баланса');
    console.log(`\n    ✓ Логин OK | ${agents.length} агентов | Чат: "${s.fullText.slice(0, 50)}..." | Токены: ${tok.data.tokens}`);
  },
};
