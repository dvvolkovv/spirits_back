/**
 * Живой E2E назначения и SLA первого ответа. Запускать только после выката
 * feature-ветки на test-стенд. Создаёт один изолированный тикет без профиля
 * пользователя и удаляет его вместе с сообщениями/событиями в finally.
 *
 *   BASE_URL=https://test.linkeon.io ADMIN_PHONE=79030169187 DEBUG_SECRET=… \
 *   SSH_TARGET=dv@85.192.61.231 BACK_PATH=/home/dv/spirits_back \
 *   node tests/support-sla.e2e.mjs
 *
 * SSH_TARGET и BACK_PATH обязательны, чтобы setup/cleanup не могли молча
 * уйти не на ту машину. DEBUG_SECRET, JWT и OTP не печатаются.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import debugSecret from './debug-secret.js';
import smokeDbPsql from './smoke/db-psql.js';

const { sshPsql } = smokeDbPsql;
const need = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`задай ${key}`);
  return value;
};
const BASE = need('BASE_URL').replace(/\/+$/, '');
const PHONE = process.env.ADMIN_PHONE || process.env.TEST_PHONE || '79030169187';
const SSH_TARGET = need('SSH_TARGET');
const BACK_PATH = need('BACK_PATH');
debugSecret.debugSecret();

const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const CALL_TIMEOUT_MS = 30_000;
const TICKET_ID = randomUUID();
const TEST_USER_ID = `support-sla-e2e-${randomUUID()}`;
const MARKER = `support-sla-e2e:${TICKET_ID}`;
const dbOptions = { target: SSH_TARGET, backPath: BACK_PATH };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (message) => console.log(`✓ ${message}`);
let mayCleanup = false;

async function request(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, body: payload };
}

async function ok(method, path, options = {}) {
  const response = await request(method, path, options);
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${method} ${path}: HTTP ${response.status}`,
  );
  return response.body;
}

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      await ok('GET', `/webhook/${SMS_WH}/sms/${PHONE}?nosms=1`);
      await sleep(1200);
      const codeResponse = await ok('GET', `/webhook/debug/sms-code/${PHONE}`, {
        headers: debugSecret.debugHeaders(),
      });
      assert.ok(codeResponse?.code, 'debug-код не выдан');
      const auth = await ok('GET', `/webhook/${CHECK_WH}/check-code/${PHONE}/${codeResponse.code}`);
      assert.ok(auth?.['access-token'], 'вход не прошёл');
      return auth['access-token'];
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(5000);
    }
  }
}

function isOverdue(ticket) {
  return !ticket.firstOwnerReplyAt
    && Date.parse(ticket.firstResponseDueAt) < Date.now();
}

function findTicket(queue, id = TICKET_ID) {
  const ticket = queue.find((item) => item.id === id);
  assert.ok(ticket, `тикет ${id} не найден в очереди`);
  return ticket;
}

async function detail(token) {
  return ok('GET', `/webhook/support/admin/ticket/${TICKET_ID}`, { token });
}

async function assign(token, assigneeId, expectedUpdatedAt) {
  return ok('POST', `/webhook/support/admin/ticket/${TICKET_ID}/assign`, {
    token,
    body: { assigneeId, expectedUpdatedAt },
  });
}

async function run() {
  const collisions = Number(sshPsql(
    `SELECT count(*) FROM support_tickets WHERE id = '${TICKET_ID}' OR user_id = '${TEST_USER_ID}';`,
    dbOptions,
  ));
  assert.equal(collisions, 0, 'случайный ID тикета уже занят — чужие данные не трогаю');

  sshPsql(
    `BEGIN;
     INSERT INTO support_tickets
       (id, user_id, status, urgency, topic, escalation_reason,
        created_at, updated_at, first_response_due_at)
     VALUES
       ('${TICKET_ID}', '${TEST_USER_ID}', 'escalated', 'critical', '${MARKER}', '${MARKER}',
        now() - interval '2 hours', now(), now() - interval '2 hours' + interval '15 minutes');
     INSERT INTO support_events (ticket_id, actor_type, action, payload, created_at)
     VALUES ('${TICKET_ID}', 'system', 'escalate',
             jsonb_build_object('reason', '${MARKER}'), now() - interval '2 hours');
     COMMIT;`,
    dbOptions,
  );
  mayCleanup = true;

  const token = await login();
  const profile = await ok('GET', '/webhook/profile', { token });
  const adminId = profile?.[0]?.profileJson?.user_id;
  assert.equal(profile?.[0]?.profileJson?.isadmin, true, 'ADMIN_PHONE должен принадлежать админу');
  assert.ok(adminId, 'профиль не вернул фактический user_id администратора');
  const operators = await ok('GET', '/webhook/support/admin/operators', { token });
  const currentAdmin = operators.find((operator) => operator.id === adminId);
  const otherAdmin = operators.find((operator) => operator.id !== adminId);
  assert.ok(currentAdmin, 'фактический user_id администратора отсутствует среди operators');
  assert.ok(otherAdmin, 'для проверки переназначения нужен второй активный администратор');
  pass('админ авторизован, operators содержит его фактический ID и второго оператора');

  const initial = await detail(token);
  assert.equal(initial.ticket.id, TICKET_ID);
  assert.equal(initial.ticket.status, 'escalated');
  assert.equal(initial.ticket.assigned_to, null);
  assert.equal(initial.ticket.first_owner_reply_at, null);
  const escalation = initial.events.find((event) => event.action === 'escalate');
  assert.ok(escalation, 'событие эскалации не возвращено');
  assert.equal(
    Date.parse(initial.ticket.first_response_due_at) - Date.parse(escalation.created_at),
    15 * 60_000,
    'critical SLA должен наступать через 15 минут после эскалации',
  );
  assert.ok(Date.parse(initial.ticket.first_response_due_at) < Date.now(), 'тикет должен быть просрочен');

  const queue = await ok('GET', '/webhook/support/admin/tickets?status=all&limit=200', { token });
  const queueIndex = queue.findIndex((ticket) => ticket.id === TICKET_ID);
  assert.ok(queueIndex >= 0, 'просроченный тикет не попал в общую очередь');
  const firstNotOverdue = queue.findIndex((ticket) => !isOverdue(ticket));
  assert.ok(
    firstNotOverdue === -1 || queueIndex < firstNotOverdue,
    'просроченный тикет стоит после непросроченного',
  );
  assert.ok(isOverdue(queue[queueIndex]), 'запись очереди не помечена просроченной по SLA-полям');
  const overdue = await ok('GET', '/webhook/support/admin/tickets?sla=overdue&status=all&limit=200', { token });
  findTicket(overdue);
  assert.ok(overdue.every(isOverdue), 'sla=overdue вернул непросроченный или answered тикет');
  pass('эскалация и дедлайн видны, просроченный тикет идёт перед остальными и входит в overdue');

  const taken = await assign(token, adminId, initial.ticket.updated_at);
  assert.equal(taken.assigned_to, adminId);
  assert.equal(taken.status, 'owner_handling');
  assert.ok(taken.assigned_at && !Number.isNaN(Date.parse(taken.assigned_at)), 'assigned_at не дата');
  assert.equal(taken.first_response_due_at, initial.ticket.first_response_due_at);
  const mine = await ok('GET', '/webhook/support/admin/tickets?sla=mine&status=all&limit=200', { token });
  findTicket(mine);
  assert.ok(mine.every((ticket) => ticket.assignedTo === adminId), 'sla=mine вернул чужой тикет');
  pass('взятие в работу использует фактический ID администратора и попадает в mine');

  await ok('POST', `/webhook/support/admin/ticket/${TICKET_ID}/reply`, {
    token,
    body: { content: `Первый видимый ответ ${MARKER}`, visibleToUser: true },
  });
  const answered = await detail(token);
  const firstReplyAt = answered.ticket.first_owner_reply_at;
  assert.ok(firstReplyAt && !Number.isNaN(Date.parse(firstReplyAt)), 'первый ответ не остановил SLA');
  const visibleReply = answered.messages.find((message) => message.sender_type === 'owner' && message.visible_to_user);
  assert.ok(visibleReply, 'видимый ответ владельца не сохранён');
  assert.equal(firstReplyAt, visibleReply.created_at);
  const overdueAfterReply = await ok('GET', '/webhook/support/admin/tickets?sla=overdue&status=all&limit=200', { token });
  assert.ok(!overdueAfterReply.some((ticket) => ticket.id === TICKET_ID), 'answered тикет остался в overdue');
  pass('первый видимый ответ записан и останавливает SLA');

  const reassigned = await assign(token, otherAdmin.id, answered.ticket.updated_at);
  assert.equal(reassigned.assigned_to, otherAdmin.id);
  assert.equal(reassigned.first_owner_reply_at, firstReplyAt);
  assert.equal(reassigned.first_response_due_at, initial.ticket.first_response_due_at);
  const mineAfterReassign = await ok('GET', '/webhook/support/admin/tickets?sla=mine&status=all&limit=200', { token });
  assert.ok(!mineAfterReassign.some((ticket) => ticket.id === TICKET_ID), 'переназначенный тикет остался в mine');

  const stale = await request('POST', `/webhook/support/admin/ticket/${TICKET_ID}/assign`, {
    token,
    body: { assigneeId: adminId, expectedUpdatedAt: taken.updated_at },
  });
  assert.equal(stale.status, 409, 'stale expectedUpdatedAt не дал HTTP 409');
  const afterConflict = await detail(token);
  assert.equal(afterConflict.ticket.assigned_to, otherAdmin.id, '409 перезаписал текущего ответственного');
  assert.equal(afterConflict.ticket.updated_at, reassigned.updated_at, '409 изменил версию тикета');
  assert.equal(
    afterConflict.events.filter((event) => event.action === 'assignment').length,
    2,
    '409 добавил лишнее событие назначения',
  );
  pass('переназначение сохраняет SLA; stale expectedUpdatedAt даёт 409 без перезаписи');

  const unassigned = await assign(token, null, afterConflict.ticket.updated_at);
  assert.equal(unassigned.assigned_to, null);
  assert.equal(unassigned.assigned_at, null);
  assert.equal(unassigned.status, 'escalated');
  assert.equal(unassigned.first_owner_reply_at, firstReplyAt);
  assert.equal(unassigned.first_response_due_at, initial.ticket.first_response_due_at);

  const finalDetail = await detail(token);
  const assignments = finalDetail.events.filter((event) => event.action === 'assignment');
  assert.equal(assignments.length, 3);
  assert.deepEqual(
    assignments.map((event) => ({ actor: event.actor_id, from: event.payload?.from ?? null, to: event.payload?.to ?? null })),
    [
      { actor: adminId, from: null, to: adminId },
      { actor: adminId, from: adminId, to: otherAdmin.id },
      { actor: adminId, from: otherAdmin.id, to: null },
    ],
  );
  pass('снятие назначения возвращает escalated; история take/reassign/unassign полна');
}

async function cleanup() {
  if (!mayCleanup) return;
  const removed = sshPsql(
    `BEGIN;
     DELETE FROM support_tickets
      WHERE id = '${TICKET_ID}' AND user_id = '${TEST_USER_ID}' AND topic = '${MARKER}'
      RETURNING id;
     COMMIT;`,
    dbOptions,
  );
  assert.equal(removed, TICKET_ID, 'тестовый тикет не удалён или не совпали защитные признаки');
  pass('только тестовый тикет и его сообщения/события удалены одной DB-транзакцией');
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
  console.error(`✗ ${error?.message || error}`);
} finally {
  try {
    await cleanup();
  } catch (error) {
    failure ||= error;
    console.error(`✗ чистка: ${error?.message || error}`);
  }
}

if (failure) process.exitCode = 1;
else console.log('✓ все проверки назначения и SLA зелёные');
