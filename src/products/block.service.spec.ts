import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  BlockService,
  JOB_KILLED_BY_BLOCK,
  JOB_KILLED_BY_UNBLOCK,
  TURN_KILLED_BY_BLOCK,
} from './block.service';

/**
 * ЧТО СТОРОЖИТ ЭТОТ ФАЙЛ, А ЧТО НЕТ.
 *
 * Здесь pg подменён целиком, значит проверяется ФОРМА запроса и разбор ключа —
 * то, что видно до всякой базы. Само гашение (частичный уникальный индекс,
 * порядок частей WITH, замок, условие единственности) исполняется только на
 * живом Postgres: сценарии 96–103б в provisioning.integration.spec.ts.
 *
 * Разделение не формальное. Мутация «убрать ON CONFLICT DO NOTHING» здесь
 * невидима (форма запроса менялась бы, но заглушка её исполняет одинаково), а
 * на живой базе падает с 23505 на каждом продукте с активным заданием. И
 * наоборот: разбор ключа на живой базе проверяется только по исходу «нашли/не
 * нашли», а подмена `p.slug` на `p.domain` в одной из веток видна здесь сразу.
 */
describe('BlockService', () => {
  const makeService = (rows: any[] = [{ id: 'p-1', slug: 'shop', status: 'running', archived: false, queued: '1', killed_jobs: '0', killed_turns: '0' }]) => {
    const calls: { sql: string; params?: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      }),
    };
    const svc = new BlockService(pg as any);
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    return { svc, pg, calls };
  };

  afterEach(() => jest.restoreAllMocks());

  // ───────────────────────────── разбор ключа ─────────────────────────────

  it('идентификатор ищется по id, домен по domain, остальное по slug', async () => {
    // ТРИ ВЕТКИ, ТРИ КОЛОНКИ. Подменённая колонка в одной из них даёт
    // «продукт не найден» — отказ, неотличимый от честного промаха.
    for (const [key, predicate] of [
      ['3f1d7c4e-0b2a-4c6d-8e9f-1a2b3c4d5e6f', 'p.id = $1'],
      ['shop.c.linkeon.io', 'p.domain = $1::text'],
      ['shop', 'p.slug = $1::text'],
    ] as const) {
      const { svc, calls } = makeService();
      await svc.block(key, 'нарушение');
      expect(calls[0].sql).toContain(predicate);
      expect(calls[0].params![0]).toBe(key);
    }
  });

  it('форма идентификатора проверяется ПЕРВОЙ, а не после слага', async () => {
    // SLUG_RE пропускает строчные буквы, цифры и дефисы внутри — то есть
    // идентификатор формально проходит и за слаг тоже. Обратный порядок
    // проверок искал бы uuid в колонке slug и не находил бы ничего.
    const { svc, calls } = makeService();
    await svc.block('3f1d7c4e-0b2a-4c6d-8e9f-1a2b3c4d5e6f', 'нарушение');
    expect(calls[0].sql).toContain('p.id = $1');
    expect(calls[0].sql).not.toContain('p.slug = $1');
  });

  it('точка решает «домен», и запасного поиска по слагу НЕТ', async () => {
    // Молчаливый поиск «сначала так, потом иначе» однажды погасил бы не тот
    // продукт: слаг одного совпадает с началом домена другого по построению.
    const { svc, pg, calls } = makeService([]);
    await expect(svc.block('shop.c.linkeon.io', 'нарушение')).rejects.toThrow(NotFoundException);
    // ОДИН запрос, а не два: второй и был бы тем самым запасным вариантом.
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(calls[0].sql).toContain('p.domain');
  });

  it('ключ обрезается и приводится к нижнему регистру', async () => {
    const { svc, calls } = makeService();
    await svc.block('  SHOP.C.Linkeon.IO  ', 'нарушение');
    expect(calls[0].params![0]).toBe('shop.c.linkeon.io');
  });

  it('пустой ключ и пустая причина не доходят до базы вовсе', async () => {
    // Причина попадает в карточку владельца и остаётся ЕДИНСТВЕННЫМ, из чего
    // он узнает, что случилось: общего списка у администратора нет,
    // уведомлений кусок 4б не делает.
    const { svc, pg } = makeService();
    await expect(svc.block('   ', 'нарушение')).rejects.toThrow(BadRequestException);
    await expect(svc.block('shop', '\n\t ')).rejects.toThrow(BadRequestException);
    await expect(svc.block('shop', undefined as any)).rejects.toThrow(BadRequestException);
    await expect(svc.unblock('')).rejects.toThrow(BadRequestException);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('причина записывается обрезанной, а не как пришла', async () => {
    const { svc, calls } = makeService();
    await svc.block('shop', '  нарушение  ');
    expect(calls[0].params![1]).toBe('нарушение');
  });

  it('отказ по домену подсказывает про бота, отказ по слагу — нет', async () => {
    // У бота домена НЕТ вовсе, то есть по домену он не находится никогда и ни
    // при какой опечатке. Администратор, не знающий этого, будет перебирать
    // написания домена, которого не существует.
    const { svc } = makeService([]);
    await expect(svc.block('shop.c.linkeon.io', 'r')).rejects.toThrow(/у бота домена нет/i);
    await expect(svc.block('shop', 'r')).rejects.not.toThrow(/у бота домена нет/i);
    await expect(svc.block('shop', 'r')).rejects.toThrow(/не найден по слагу/i);
  });

  // ─────────────────────────── форма запроса ───────────────────────────

  it('гашение — ОДИН оператор: снятие задания, убийство хода, статус, задание', async () => {
    // Гонки в этом модуле закрывает форма запроса, а не транзакция: каждое
    // действие — один оператор со своими предусловиями внутри. Разложенное на
    // четыре, гашение оставляло бы продукт наполовину погашенным на каждой
    // смерти процесса.
    const { svc, pg, calls } = makeService();
    await svc.block('shop', 'нарушение');

    expect(pg.query).toHaveBeenCalledTimes(1);
    const sql = calls[0].sql;
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toMatch(/UPDATE product_provision_jobs[\s\S]*status = 'failed'/);
    expect(sql).toMatch(/UPDATE product_turns[\s\S]*status = 'failed'/);
    expect(sql).toMatch(/SET status = 'blocked', block_reason = \$2/);
    expect(sql).toMatch(/INSERT INTO product_provision_jobs[\s\S]*'sleep', 'queued'/);
    expect(calls[0].params).toEqual([
      'shop',
      'нарушение',
      JOB_KILLED_BY_BLOCK,
      TURN_KILLED_BY_BLOCK,
    ]);
  });

  it('ход убивается БЕЗ оглядки на признаки жизни — в этом отличие от сна', async () => {
    // requestSleep отказывается ставить задание, пока ход подаёт признаки
    // жизни (`last_progress_at > now() - 30 минут`). У блокировки цель другая:
    // её ставят, когда на домене недопустимое. Появись здесь тот же фильтр —
    // недопустимый продукт жил бы до получаса.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    const turns = calls[0].sql.slice(calls[0].sql.indexOf('UPDATE product_turns'));
    expect(turns).toContain("tr.status IN ('queued','running')");
    expect(turns).not.toContain('last_progress_at');
  });

  it('вставка задания ССЫЛАЕТСЯ на снятие — этим закреплён порядок частей WITH', async () => {
    // Части WITH исполняются «одновременно», порядок между ними не обещан
    // ничем. Измерено на PostgreSQL 16: без ссылки вставка исполняется РАНЬШЕ
    // снятия и упирается в живое задание — 23505. Условие всегда истинно и
    // существует ровно затем, чтобы этого не было.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    expect(calls[0].sql).toContain('(SELECT count(*) FROM killed_jobs) >= 0');
  });

  it('ON CONFLICT DO NOTHING в гашении НЕТ — конфликт обязан быть громким', async () => {
    // Он выглядит бесплатной страховкой и страхует не от того. Собственное
    // снятие конфликта не даёт (измерено), значит единственный оставшийся
    // конфликт — чужая вставка активного задания. Без ON CONFLICT она роняет
    // ВЕСЬ оператор, то есть откатывает и перевод в blocked: ничего не
    // произошло, повтор безопасен. С ON CONFLICT откатывать нечего — продукт
    // остаётся блокированным БЕЗ задания, то есть с работающим контейнером.
    //
    // Сторож ФОРМЫ и единственный возможный: поведенческого нет, потому что
    // воспроизвести чужую вставку внутри одного оператора нечем.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    // Ищем ОПЕРАТОР, а не подстроку: слова «ON CONFLICT DO NOTHING» стоят в
    // объяснении внутри самого SQL, и `not.toContain` краснел бы на
    // комментарии, который и написан затем, чтобы его не вернули.
    expect(calls[0].sql).not.toMatch(/\n\s*ON CONFLICT/);
  });

  it('конфликт по уникальному индексу объясняется словами, а не 500', async () => {
    // Оператор откатывается целиком, то есть состояние ЦЕЛОЕ и повтор
    // безопасен — и это надо сказать, а не отдать «duplicate key value
    // violates unique constraint». Сверка по коду, а не по тексту: текст
    // приходит от PostgreSQL и на другой локали он другой.
    const pg = { query: jest.fn(async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); }) };
    const svc = new BlockService(pg as any);
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    const err = await svc.block('shop', 'нарушение').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/ничего не изменилось/i);
  });

  it('чужая ошибка базы пробрасывается как есть, а не выдаётся за гонку', async () => {
    const pg = { query: jest.fn(async () => { throw Object.assign(new Error('column does not exist'), { code: '42703' }); }) };
    const svc = new BlockService(pg as any);
    await expect(svc.block('shop', 'нарушение')).rejects.toThrow(/column does not exist/);
  });

  it('archived_at стоит в ПРАВКЕ, а не в поиске', async () => {
    // В поиске он превратил бы архивный продукт в «не найден», и
    // администратор пошёл бы искать опечатку в домене, которого нет.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    const found = calls[0].sql.slice(
      calls[0].sql.indexOf('found AS'),
      calls[0].sql.indexOf('target AS'),
    );
    expect(found).not.toContain('archived_at IS NULL');
    expect(calls[0].sql).toContain('f.archived_at IS NULL');
  });

  it('правки идут только при РОВНО ОДНОМ совпадении, и условие стоит до записи', async () => {
    // У products.domain нет ни UNIQUE, ни первичного ключа. Две строки с одним
    // доменом — и гашение по жалобе на один продукт погасило бы соседний.
    // Проверка постфактум не спасла бы: правка к тому моменту уже случилась.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    const target = calls[0].sql.slice(
      calls[0].sql.indexOf('target AS'),
      calls[0].sql.indexOf('killed_jobs AS'),
    );
    expect(target).toContain('(SELECT count(*) FROM found) = 1');
  });

  it('sleep_reason гашением не трогается', async () => {
    // Продукт мог спать за неуплату до блокировки, и снятие вернёт его в
    // 'sleeping': стёртая причина оставила бы владельца со спящим продуктом
    // без объяснения.
    const { svc, calls } = makeService();
    await svc.block('shop', 'нарушение');
    expect(calls[0].sql).not.toContain('sleep_reason =');
  });

  // ────────────────────────── разбор ответа ──────────────────────────

  it('ноль строк — «не найден», две строки — «найден не один»', async () => {
    const empty = makeService([]);
    await expect(empty.svc.block('shop', 'r')).rejects.toThrow(NotFoundException);

    const many = makeService([
      { id: 'a', slug: 'a', status: 'running', archived: false, queued: '0' },
      { id: 'b', slug: 'b', status: 'running', archived: false, queued: '0' },
    ]);
    const err = await many.svc.block('shop.c.linkeon.io', 'r').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    // Слаги названы: администратору надо знать, между чем выбирать.
    expect(err.message).toContain('a, b');
  });

  it('архивный — свой отказ, и слово «не найден» в нём не звучит', async () => {
    const { svc } = makeService([
      { id: 'p-1', slug: 'old', status: 'archived', archived: true, queued: '0' },
    ]);
    const err = await svc.block('old', 'r').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/в архиве/i);
    expect(err.message).not.toMatch(/не найден/i);
  });

  it('задание не встало — ГРОМКИЙ отказ, а не тихий успех', async () => {
    // Продукт при этом уже блокирован: аренда с него не берётся, правки не
    // принимаются. Не хватает ровно задания агенту, то есть контейнер
    // продолжает работать — тот самый исход, ради предотвращения которого всё
    // написано. Молчание здесь было бы худшим из возможных ответов.
    const { svc } = makeService([
      { id: 'p-1', slug: 'shop', status: 'running', archived: false, queued: '0' },
    ]);
    const spy = jest.spyOn((svc as any).logger, 'error');
    await expect(svc.block('shop', 'нарушение')).rejects.toThrow(/не встало/i);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('контейнер работает'));
  });

  it('удачное гашение пишет строку в журнал — единственный след решения', async () => {
    // Общего списка продуктов у администратора нет, уведомлений владельцу
    // кусок 4б не делает: «кто и за что погасил» через полгода не ответит
    // больше никто.
    const { svc } = makeService();
    const spy = jest.spyOn((svc as any).logger, 'warn');
    await svc.block('shop', 'нарушение');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('нарушение'));
  });

  // ──────────────────────── снятие блокировки ────────────────────────

  it('снятие ставит sleeping, чистит причину и снимает активное задание', async () => {
    // 'running' здесь ставить нельзя: перевод в работу делает promoteReady по
    // измеримому факту. Активное задание снимается потому, что у
    // блокированного штатно висит НАШЕ ЖЕ гашение — иначе пробуждение не
    // встанет по уникальному индексу, а агент погасит контейнер следом.
    const { svc, pg, calls } = makeService([
      { id: 'p-1', slug: 'shop', status: 'blocked', archived: false, queued: '1', killed_jobs: '1' },
    ]);
    await svc.unblock('shop');

    expect(pg.query).toHaveBeenCalledTimes(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/SET status = 'sleeping', block_reason = NULL/);
    // Не `SET status = 'running'`: 'running' в тексте встречается ещё и в
    // отборе активных заданий, поэтому сверяется именно присваивание.
    expect(sql).not.toMatch(/SET status = 'running'/);
    expect(sql).toMatch(/UPDATE product_provision_jobs[\s\S]*status = 'failed'/);
    expect(sql).toMatch(/INSERT INTO product_provision_jobs[\s\S]*'wake', 'queued'/);
    expect(sql).not.toMatch(/\n\s*ON CONFLICT/);
    expect(sql).toContain('(SELECT count(*) FROM killed_jobs) >= 0');
    expect(calls[0].params).toEqual(['shop', JOB_KILLED_BY_UNBLOCK]);
  });

  it('снятие не трогает ходы: у блокированного их не бывает', async () => {
    const { svc, calls } = makeService([
      { id: 'p-1', slug: 'shop', status: 'blocked', archived: false, queued: '1', killed_jobs: '0' },
    ]);
    await svc.unblock('shop');
    expect(calls[0].sql).not.toContain('product_turns');
  });

  it('снятие с НЕ блокированного — свой отказ, а не «не найден»', async () => {
    // Продукт есть, ключ верный. «Не найден» отправил бы администратора искать
    // опечатку там, где её нет.
    const { svc } = makeService([
      { id: 'p-1', slug: 'shop', status: 'running', archived: false, queued: '0' },
    ]);
    const err = await svc.unblock('shop').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/не блокирован/i);
    expect(err.message).toContain('running');
  });

  it('снятие: пробуждение не встало — тоже громко', async () => {
    const { svc } = makeService([
      { id: 'p-1', slug: 'shop', status: 'blocked', archived: false, queued: '0', killed_jobs: '1' },
    ]);
    const spy = jest.spyOn((svc as any).logger, 'error');
    await expect(svc.unblock('shop')).rejects.toThrow(/не встало/i);
    expect(spy).toHaveBeenCalled();
  });

  it('снятие: условие blocked стоит в ЗАПРОСЕ, а не только в разборе ответа', async () => {
    // Проверка постфактум пропустила бы гонку: два снятия подряд, и второе
    // поставило бы сорвавшемуся продукту второе пробуждение.
    const { svc, calls } = makeService([
      { id: 'p-1', slug: 'shop', status: 'blocked', archived: false, queued: '1', killed_jobs: '0' },
    ]);
    await svc.unblock('shop');
    const target = calls[0].sql.slice(
      calls[0].sql.indexOf('target AS'),
      calls[0].sql.indexOf('killed_jobs AS'),
    );
    expect(target).toContain("f.status = 'blocked'");
    expect(target).toContain('f.archived_at IS NULL');
    expect(target).toContain('(SELECT count(*) FROM found) = 1');
  });
});
