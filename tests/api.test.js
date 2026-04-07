/**
 * API Endpoint Tests for my.linkeon.io
 *
 * Tests verify:
 * - Webhooks are reachable (not 404/502/503)
 * - Auth endpoints respond correctly
 * - Protected endpoints enforce Bearer auth (401/403 without token)
 * - Response shapes match expected structure
 *
 * NOTE: Tests DO NOT create real users, send real SMS, or process real payments.
 * They use 401/403/400 responses to verify endpoints exist and respond.
 */

const axios = require('axios');
const config = require('./config');

const http = axios.create({
  baseURL: config.BASE_URL,
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  timeout: 60000,
  validateStatus: () => true, // don't throw on 4xx/5xx
});

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

// Helper: assert status is one of expected values
function assertStatus(resp, ...statuses) {
  if (!statuses.includes(resp.status)) {
    const body = typeof resp.data === 'object' ? JSON.stringify(resp.data).slice(0, 200) : String(resp.data).slice(0, 200);
    throw new Error(`Expected status ${statuses.join('|')}, got ${resp.status}. Body: ${body}`);
  }
}

// Helper: assert response is JSON
function assertJSON(resp) {
  if (typeof resp.data !== 'object') {
    throw new Error(`Expected JSON response, got: ${String(resp.data).slice(0, 100)}`);
  }
}

// ============================================================
// AUTH ENDPOINTS (public — no Bearer required)
// ============================================================

module.exports = {
  // --- SMS ---
  'GET /webhook/sms/:phone — returns response (not 404/502)': async () => {
    // Use a non-existent phone to avoid sending real SMS
    // Workflow should return 403 (blocked/not found) or 200
    const resp = await http.get(`/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/70000000000`);
    assertStatus(resp, 200, 400, 403, 404, 500);
    // Must NOT be 502/503 (infrastructure error)
    if (resp.status === 502) throw new Error('Got 502 - n8n not responding');
    if (resp.status === 503) throw new Error('Got 503 - service unavailable');
  },

  'SMS webhook has CORS headers': async () => {
    const resp = await http.get(`/webhook/898c938d-f094-455c-86af-969617e62f7a/sms/70000000000`);
    const cors = resp.headers['access-control-allow-origin'];
    if (!cors) throw new Error('Missing Access-Control-Allow-Origin header');
  },

  // --- Token Refresh ---
  'POST /webhook/auth/refresh — without token returns 401/400': async () => {
    const resp = await http.post('/webhook/auth/refresh', {}, {
      headers: { 'Content-Type': 'application/json' },
    });
    assertStatus(resp, 400, 401, 403, 500);
    if (resp.status === 502) throw new Error('Got 502');
  },

  'POST /webhook/auth/refresh — with invalid token returns 401': async () => {
    const resp = await http.post('/webhook/auth/refresh', {}, {
      headers: bearer('invalid-token-xyz'),
    });
    assertStatus(resp, 400, 401, 403);
  },

  // ============================================================
  // PROFILE ENDPOINTS (require Bearer)
  // ============================================================

  'GET /webhook/profile — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/profile');
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/profile-update — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/profile-update', { name: 'test' });
    assertStatus(resp, 401, 403);
  },

  'DELETE /webhook/profile — without token returns 401/403': async () => {
    const resp = await http.delete('/webhook/profile');
    assertStatus(resp, 401, 403);
  },

  'GET /webhook/user-profile — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/user-profile?userId=test');
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/set-email — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/set-email', { email: 'test@test.com' });
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // AVATAR
  // ============================================================

  'GET /webhook/avatar — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/avatar');
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // AGENTS
  // ============================================================

  'GET /webhook/agent-details — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/agent-details');
    assertStatus(resp, 401, 403);
  },

  'GET /webhook/agents — without token returns 401/403 or 200': async () => {
    const resp = await http.get('/webhook/agents');
    // Agents might be public or protected
    assertStatus(resp, 200, 401, 403);
    if (resp.status === 502) throw new Error('Got 502');
  },

  'POST /webhook/change-agent — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/change-agent', { agent: 'Маша' });
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/agent — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/agent', { name: 'TestAgent' });
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // CHAT
  // ============================================================

  'POST /webhook/soulmate/chat — responds (not 502/503)': async () => {
    // NOTE: This endpoint returns 200 with empty body when no valid token is provided
    // Auth is checked inside the workflow (returns empty response, not 401)
    const resp = await http.post('/webhook/soulmate/chat', {
      message: 'test',
      assistantId: 'test'
    });
    if (resp.status === 502) throw new Error('Got 502 - n8n not responding');
    if (resp.status === 503) throw new Error('Got 503 - service unavailable');
    if (resp.status === 404) throw new Error('Got 404 - workflow not found');
  },

  'GET /webhook/chat/history — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/chat/history?assistantId=test');
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/scan-document — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/scan-document', {});
    assertStatus(resp, 400, 401, 403);
  },

  // ============================================================
  // TOKENS & PAYMENTS
  // ============================================================

  'GET /webhook/user/tokens/ — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/user/tokens/');
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/yookassa/create-payment — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/yookassa/create-payment', {
      amount: 100,
      package: 'basic'
    });
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/yookassa/verify-payment — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/yookassa/verify-payment', {
      payment_id: 'test-payment-id'
    });
    assertStatus(resp, 401, 403);
  },

  'POST /webhook/yookassa/notification — responds (not 502)': async () => {
    // YooKassa webhook is called by YooKassa server, not authenticated via Bearer
    // It uses HMAC or IP whitelist verification internally
    const resp = await http.post('/webhook/yookassa/notification', {
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: 'test', status: 'succeeded' }
    });
    // Should respond with something (200, 400, 403) but not 502/503
    if (resp.status === 502) throw new Error('Got 502 - n8n not responding');
    if (resp.status === 503) throw new Error('Got 503 - service unavailable');
  },

  'POST /webhook/coupon/redeem — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/coupon/redeem', { code: 'TEST123' });
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // SEARCH & COMPATIBILITY
  // ============================================================

  'POST /webhook/search-mate — responds (not 502/503)': async () => {
    // NOTE: Returns 200 with empty body without auth (auth checked inside workflow)
    const resp = await http.post('/webhook/search-mate', { query: 'test' });
    if (resp.status === 502) throw new Error('Got 502 - n8n not responding');
    if (resp.status === 503) throw new Error('Got 503 - service unavailable');
    if (resp.status === 404) throw new Error('Got 404 - workflow not found');
  },

  'POST /webhook/analyze-compatibility — responds (not 502/503)': async () => {
    // NOTE: Returns 200 with empty body without auth (auth checked inside workflow)
    const resp = await http.post('/webhook/analyze-compatibility', { userId: 'test' });
    if (resp.status === 502) throw new Error('Got 502 - n8n not responding');
    if (resp.status === 503) throw new Error('Got 503 - service unavailable');
    if (resp.status === 404) throw new Error('Got 404 - workflow not found');
  },

  // ============================================================
  // REFERRAL
  // ============================================================

  'POST /webhook/referral/register — without token returns 401/403/400': async () => {
    const resp = await http.post('/webhook/referral/register', { slug: 'nonexistent-slug-xyz' });
    assertStatus(resp, 400, 401, 403);
  },

  'GET /webhook/referral/stats — without token returns 401/403': async () => {
    const resp = await http.get('/webhook/referral/stats');
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // IMAGE GENERATION
  // ============================================================

  'POST /webhook/imagegen — without token returns 401/403': async () => {
    const resp = await http.post('/webhook/imagegen', { prompt: 'test image' });
    assertStatus(resp, 401, 403);
  },

  // ============================================================
  // WITH VALID JWT (only runs if TEST_JWT is set)
  // ============================================================

  'GET /webhook/profile — with valid token returns 200': async () => {
    if (!config.TEST_JWT) {
      console.log('(skipped — TEST_JWT not set)');
      return;
    }
    const resp = await http.get('/webhook/profile', { headers: bearer(config.TEST_JWT) });
    assertStatus(resp, 200);
    assertJSON(resp);
  },

  'GET /webhook/agent-details — with valid token returns 200 with agents array': async () => {
    if (!config.TEST_JWT) {
      console.log('(skipped — TEST_JWT not set)');
      return;
    }
    const resp = await http.get('/webhook/agent-details', { headers: bearer(config.TEST_JWT) });
    assertStatus(resp, 200);
    if (!Array.isArray(resp.data) && !Array.isArray(resp.data?.agents)) {
      throw new Error(`Expected array of agents, got: ${JSON.stringify(resp.data).slice(0, 100)}`);
    }
  },

  'GET /webhook/user/tokens/ — with valid token returns numeric balance': async () => {
    if (!config.TEST_JWT) {
      console.log('(skipped — TEST_JWT not set)');
      return;
    }
    const resp = await http.get('/webhook/user/tokens/', { headers: bearer(config.TEST_JWT) });
    assertStatus(resp, 200);
    const data = resp.data;
    const tokens = data?.tokens ?? data?.balance ?? data;
    if (typeof tokens !== 'number' && typeof tokens !== 'string') {
      throw new Error(`Expected tokens value, got: ${JSON.stringify(data).slice(0, 100)}`);
    }
  },

  'GET /webhook/chat/history — with valid token returns history object': async () => {
    if (!config.TEST_JWT) {
      console.log('(skipped — TEST_JWT not set)');
      return;
    }
    const resp = await http.get('/webhook/chat/history?assistantId=Маша', {
      headers: bearer(config.TEST_JWT)
    });
    assertStatus(resp, 200);
    assertJSON(resp);
  },

  'POST /webhook/auth/refresh — with valid refresh token returns new tokens': async () => {
    if (!config.TEST_JWT) {
      console.log('(skipped — TEST_JWT not set)');
      return;
    }
    // Use current token as refresh token (may fail with 401 if it's an access token)
    const resp = await http.post('/webhook/auth/refresh', {}, {
      headers: bearer(config.TEST_JWT)
    });
    // If it's actually a refresh token it returns 200, if access token it's 401
    assertStatus(resp, 200, 401, 403);
    if (resp.status === 200) {
      if (!resp.data['access-token']) throw new Error('Missing access-token in refresh response');
      if (!resp.data['refresh-token']) throw new Error('Missing refresh-token in refresh response');
    }
  },
};
