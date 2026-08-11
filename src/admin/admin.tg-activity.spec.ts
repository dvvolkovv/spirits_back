import { AdminService } from './admin.service';

/**
 * Активность пользователей, живущих в Telegram-боте.
 *
 * Заведено по факту: у 79235216999 (arm_g42) две оплаты premium по 1990 ₽ и
 * 155 сообщений в `tg_bot_messages` — а карточка активности в админке была
 * пустой, потому что каждый «сообщенческий» блок читал только
 * `custom_chat_history`. Выглядело как «человек заплатил и не пользуется»,
 * хотя он выговорил 1 032 363 токена.
 *
 * Тот же слепой источник в сегментах обзвона: 22.06 Арман получил
 * активационный нудж «зарегистрировался и не начал» — через два дня после
 * того, как привязал бота и написал в него девять сообщений.
 *
 * Деньги (`spent_*`, `last_active`, расход на графике) сюда не входят: с
 * 9b40a80 TG-списания идут через consume_user_tokens и уже попадают в
 * token_transactions.
 */

interface Recorded {
  sql: string;
  params: any[];
}

/** Подставной pg: запоминает запросы и отдаёт заготовленные ответы. */
function fakePg(rows: Record<string, any[]> = {}) {
  const calls: Recorded[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      for (const [needle, value] of Object.entries(rows)) {
        if (sql.includes(needle)) return { rows: value };
      }
      return { rows: [] };
    },
  };
}

function serviceWith(pg: any): AdminService {
  return new AdminService(pg as any);
}

/** Карточка отдаёт нули и пустые списки, если профиля нет — нужен хотя бы он. */
const PROFILE_ROW = [{
  phone: '79235216999',
  registered_at: '2026-06-10T14:17:31Z',
  balance: '1000000',
  email: 'armangalduryan@gmail.com',
  isadmin: false,
  preferred_agent: null,
  paid_count: 2,
  paid_rub: '3980',
  referral_leader_name: null,
  spent_total: '0',
  spent_period: '0',
  last_active: null,
}];

/** Запрос, в тексте которого встречается needle. */
function sqlWith(pg: ReturnType<typeof fakePg>, needle: string): string | undefined {
  return pg.calls.map(c => c.sql).find(s => s.includes(needle));
}

describe('AdminService.getUserActivity — пользователь из Telegram-бота', () => {
  it('«Последние сообщения» собираются из веба и из бота', async () => {
    const pg = fakePg({ 'FROM ai_profiles_consolidated a': PROFILE_ROW });
    await serviceWith(pg).getUserActivity('79235216999');

    const sql = sqlWith(pg, 'SUBSTRING');
    expect(sql).toBeDefined();
    expect(sql).toContain('custom_chat_history');
    expect(sql).toContain('tg_bot_messages');
    // Владелец бота — единственный способ связать TG-чат с linkeon-аккаунтом.
    expect(sql).toContain('owner_user_id');
  });

  it('источник и название TG-чата доезжают до карточки', async () => {
    const pg = fakePg({
      'FROM ai_profiles_consolidated a': PROFILE_ROW,
      SUBSTRING: [{
        id: '42',
        created_at: '2026-08-06T03:19:46Z',
        agent_id: 12,
        agent_name: 'Роман',
        role: 'human',
        preview: 'а что если',
        source: 'telegram',
        channel_title: 'ИИ агент',
      }],
    });
    const res = await serviceWith(pg).getUserActivity('79235216999');

    expect(res.recentMessages[0]).toMatchObject({
      source: 'telegram',
      channel_title: 'ИИ агент',
      agent_name: 'Роман',
    });
  });

  it('веб-сообщения по-прежнему помечены источником web', async () => {
    const pg = fakePg({
      'FROM ai_profiles_consolidated a': PROFILE_ROW,
      SUBSTRING: [{
        id: '7',
        created_at: '2026-08-06T03:19:46Z',
        agent_id: 12,
        agent_name: 'Роман',
        role: 'ai',
        preview: 'конечно',
        source: 'web',
        channel_title: null,
      }],
    });
    const res = await serviceWith(pg).getUserActivity('79235216999');

    expect(res.recentMessages[0].source).toBe('web');
    expect(res.recentMessages[0].channel_title).toBeNull();
  });

  it('«По ассистентам» учитывает пресет-агента TG-бота', async () => {
    const pg = fakePg({ 'FROM ai_profiles_consolidated a': PROFILE_ROW });
    await serviceWith(pg).getUserActivity('79235216999');

    const sql = sqlWith(pg, 'ORDER BY queries DESC');
    expect(sql).toBeDefined();
    expect(sql).toContain('tg_bot_messages');
    expect(sql).toContain('preset_agent_id');
    // Расход TG считается по факту списания за сообщение, а не по
    // token_consumption_tasks — их TG-путь не создаёт.
    expect(sql).toContain('tokens_charged');
  });

  it('счётчик запросов не теряет сообщения из бота', async () => {
    const pg = fakePg({ 'FROM ai_profiles_consolidated a': PROFILE_ROW });
    await serviceWith(pg).getUserActivity('79235216999');

    const sql = sqlWith(pg, 'token_consumption_tasks');
    expect(sql).toContain('tg_bot_messages');
  });

  it('в дневном ряду запросы из бота попадают в свой день', async () => {
    const pg = fakePg({ 'FROM ai_profiles_consolidated a': PROFILE_ROW });
    await serviceWith(pg).getUserActivity('79235216999');

    const sql = sqlWith(pg, 'generate_series');
    expect(sql).toContain('tg_bot_messages');
    // Индекс idx_custom_chat_session должен остаться рабочим: веб-ветка
    // фильтруется префиксом session_id, а не split_part по всей таблице.
    expect(sql).toContain("session_id LIKE $1");
    expect(sql).not.toContain("split_part(session_id");
  });

  it('в счёт идут реплики человека, а не ответы ассистента', async () => {
    const pg = fakePg({ 'FROM ai_profiles_consolidated a': PROFILE_ROW });
    await serviceWith(pg).getUserActivity('79235216999');

    const series = sqlWith(pg, 'generate_series')!;
    expect(series).toContain("m.role = 'user'");
    expect(series).not.toContain("m.role = 'assistant'");
  });
});

describe('AdminService.getUsersTokensList — колонка активности в TG', () => {
  it('в выборку попадает активность из бота', async () => {
    const pg = fakePg();
    await serviceWith(pg).getUsersTokensList();

    const sql = pg.calls[0].sql;
    expect(sql).toContain('tg_bot_messages');
    expect(sql).toContain('owner_user_id');
  });

  it('строка таблицы отдаёт счётчик TG-сообщений и время последнего', async () => {
    const pg = fakePg({
      'FROM ai_profiles_consolidated a': [{
        phone: '79235216999',
        registered_at: '2026-06-10T14:17:31Z',
        balance: '1000000',
        spent_total: '0',
        spent_period: '0',
        last_active: null,
        paid_count: 2,
        paid_rub: '3980',
        referral_leader_name: null,
        tg_messages: 78,
        tg_last_active: '2026-08-06T03:19:46Z',
      }],
    });
    const res = await serviceWith(pg).getUsersTokensList();

    expect(res.users[0]).toMatchObject({
      tg_messages: 78,
      tg_last_active: '2026-08-06T03:19:46Z',
    });
  });

  // Расход TG попал в token_transactions только с 9b40a80 — у более ранней
  // активности единственный след это сами сообщения бота.
  it('last_active подхватывается из бота, если списаний в окне нет', async () => {
    const pg = fakePg({
      'FROM ai_profiles_consolidated a': [{
        phone: '79235216999',
        balance: '0',
        spent_total: '0',
        spent_period: '0',
        last_active: null,
        paid_count: 0,
        paid_rub: '0',
        referral_leader_name: null,
        tg_messages: 78,
        tg_last_active: '2026-08-06T03:19:46Z',
      }],
    });
    const res = await serviceWith(pg).getUsersTokensList();

    expect(res.users[0].last_active).toBe('2026-08-06T03:19:46Z');
  });

  it('пользователь без бота остаётся с нулём и без отметки', async () => {
    const pg = fakePg({
      'FROM ai_profiles_consolidated a': [{
        phone: '79088644408',
        balance: '876937',
        spent_total: '100',
        spent_period: '100',
        last_active: '2026-08-11T06:47:38Z',
        paid_count: 5,
        paid_rub: '9950',
        referral_leader_name: null,
        tg_messages: 0,
        tg_last_active: null,
      }],
    });
    const res = await serviceWith(pg).getUsersTokensList();

    expect(res.users[0].tg_messages).toBe(0);
    expect(res.users[0].tg_last_active).toBeNull();
    expect(res.users[0].last_active).toBe('2026-08-11T06:47:38Z');
  });
});

describe('AdminService — сегменты обзвона не трогают активных в боте', () => {
  it('активационный сегмент исключает тех, кто пишет в бота', async () => {
    const pg = fakePg();
    await serviceWith(pg).buildActivationOutreach();

    const sql = pg.calls[0].sql;
    expect(sql).toContain('custom_chat_history');
    expect(sql).toContain('tg_bot_messages');
    expect(sql).toContain('owner_user_id');
  });

  it('retention-сегмент считает последнюю активность и по боту', async () => {
    const pg = fakePg();
    await serviceWith(pg).buildRetentionOutreach();

    expect(pg.calls[0].sql).toContain('tg_bot_messages');
  });

  it('curious-сегмент считает последнюю активность и по боту', async () => {
    const pg = fakePg();
    await serviceWith(pg).buildCuriousReturnOutreach();

    expect(pg.calls[0].sql).toContain('tg_bot_messages');
  });
});
