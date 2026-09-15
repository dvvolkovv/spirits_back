import 'dotenv/config';
import { HostConfig, loadConfig } from './config';
import { HostApi, HostJob, JobReport, PollOutcome } from './api';
import { hostDeps, provision as provisionReal, ProvisionDeps } from './provision';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface HostApiLike {
  poll: () => Promise<PollOutcome>;
  complete: (jobId: string, report: JobReport) => Promise<boolean>;
}

export interface HostDeps {
  config: HostConfig;
  api: HostApiLike;
  provision: (job: HostJob) => Promise<{ port?: number }>;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Цикл опроса агента хоста: то, что связывает сервер и хостовые шаги.
 *
 * ## Главное свойство: исход развёртывания решается ДО первой попытки отчёта
 *
 * Черновик плана делал `provision` и `api.complete(ok:true)` в одном `try`, а
 * `complete(ok:false, …)` — в общем `catch`. Форма выглядит симметрично и
 * ломается на самом дорогом случае: провижининг ПРОШЁЛ, а отчёт об успехе не
 * доехал (сеть моргнула, бэкенд в этот момент перезапускался выкатом). Тогда
 * исключение из доставки ловит тот же catch, и вторым уходит отчёт
 * `{ ok: false, error: 'fetch failed' }` — **ложь о необратимом действии**.
 * Цена лжи считается по серверу: `completeJob` на отказе ставит продукту
 * `failed` и пишет в карточку сетевую ошибку, а на хосте в это время живой
 * контейнер держит слаг и порт. Кнопка «повторить» после этого упирается в
 * «контейнер уже есть», и разбирать это едет человек.
 *
 * Поэтому здесь два раздельных шага: `runJob` вычисляет исход и НЕ бросает,
 * `deliver` его доставляет и не может этот исход изменить. Отказ доставки —
 * это отказ доставки, а не отказ развёртывания.
 *
 * ## Недоставленный отчёт досылается, а не откатывается и не замалчивается
 *
 * Рассмотрены три ответа на «отчёт об успехе потерян»:
 *
 *   - оставить как есть: задание висит в 'running', через 10 минут реаппер
 *     хоронит продукт («агент не отчитался…»), контейнер живёт, порт занят,
 *     повтор невозможен без рук на хосте. Худший из трёх;
 *   - откатить провижининг (снести контейнер и vhost): уничтожает исправно
 *     поднятый продукт из-за сетевого моргка — и делает это ровно в том
 *     случае, где сервер, возможно, отчёт как раз ПОЛУЧИЛ, а потерялся ответ.
 *     Разрушительно и недоказуемо;
 *   - **досылать** — выбрано. Повтор безопасен не по удаче, а по устройству
 *     сервера: `completeJob` закрывает задание условием `AND status='running'`,
 *     поэтому повторный отчёт — no-op с предупреждением в лог, и там он прямо
 *     назван законным путём («ретрай POST-а при обрыве связи выглядит именно
 *     так»). Бюджет досылки — см. DEFAULT_REPORT_ATTEMPTS.
 *
 * Если досылка не удалась и за минуту, лгать всё равно нечем: в журнал уходит
 * громкая строка со слагом, портом и jobId — всё, что нужно, чтобы закрыть
 * задание руками, — и агент идёт дальше. Ронять процесс здесь нельзя: на
 * машине он один, и пока он лежит, не заводится ни один продукт ни у одного
 * клиента.
 */

/**
 * Один оборот: опрос, работа, отчёт. Вынесен из цикла ради проверяемости —
 * бесконечный цикл тестировать нечем, а единицу работы можно.
 *
 * Паузу держит агент, а не сервер: маршрут `products/host/poll` возвращается
 * немедленно (см. host.controller.ts), в отличие от соседнего long-poll
 * раннера. Без сна это горячий цикл по API и по базе с частотой сети.
 */
export async function tick(deps: HostDeps): Promise<void> {
  const wait = deps.sleep ?? sleep;
  const log = deps.log ?? console.log;

  const outcome = await deps.api.poll();

  if (!outcome.ok) {
    // Связи нет, токен не принят, тело не то. Не выходим: Linkeon может быть
    // просто на выкате. Пауза длиннее обычной — неверный HOST_TOKEN молчит
    // вечно, и опрос раз в три секунды навсегда это не диагностика, а нагрузка.
    log(`[host] опрос не удался: ${outcome.error}`);
    await wait(deps.config.pollIntervalMs * 3);
    return;
  }

  if (!outcome.job) {
    // Пустая очередь — обычное состояние, а не ошибка: агент опрашивает нас
    // по кругу, а продукты заводят раз в день.
    await wait(deps.config.pollIntervalMs);
    return;
  }

  const job = outcome.job;
  // В лог — только слаг, форма и id задания. Ни само задание, ни `secrets`,
  // ни `runnerToken` логировать нельзя: журнал хоста читается шире, чем
  // карточка продукта.
  log(`[host] задание ${job.jobId}: ${job.kind} ${job.slug}`);

  const report = await runJob(job, deps);
  const delivered = await deliver(job, report, deps);

  if (!delivered) {
    // Всё, что нужно человеку, чтобы закрыть задание руками. Порт и слаг — в
    // строке, потому что порт хранится ТОЛЬКО в отчёте: восстановить его
    // серверу неоткуда.
    log(
      `[host] ВНИМАНИЕ: отчёт по заданию ${job.jobId} (${job.slug}) не доставлен. `
        + `Исход: ${report.ok ? `успех, порт ${report.port ?? 'нет'}` : `отказ — ${report.error}`}. `
        + 'Сервер закроет задание по сроку, состояние на хосте надо сверить руками.',
    );
  }
  // Паузы после задания нет намеренно: пока агент работал, кнопку мог нажать
  // второй клиент, и очередь разбирается подряд. Горячего цикла это не даёт —
  // задание уже забрано и в 'queued' не вернётся.
}

/**
 * Развёртывание. НЕ бросает: исход — это всегда отчёт, в том числе отказ.
 *
 * Молчаливое проглатывание оставило бы задание в 'running' навсегда, а продукт
 * висел бы в 'provisioning' до реаппера с чужой формулировкой про истёкший
 * срок — вместо настоящей причины, известной здесь и больше нигде.
 */
export async function runJob(job: HostJob, deps: HostDeps): Promise<JobReport> {
  try {
    const { port } = await deps.provision(job);
    // Ключ `port` кладётся только когда он есть. У бота публикации порта нет
    // вовсе, и `{ ok: true, port: undefined }` — не то же самое, что
    // `{ ok: true }`: первое читается в логе и в теле как «порт потерян».
    // Серверу безразлично (там COALESCE), человеку — нет.
    return port === undefined ? { ok: true } : { ok: true, port };
  } catch (e: any) {
    return { ok: false, error: describeFailure(e, job) };
  }
}

/**
 * Причина отказа в том виде, в каком её увидит владелец продукта в кабинете.
 *
 * Остатки — ВПЕРЕДИ сообщения, и это не вкусовщина: сервер подрезает причину
 * до 2000 символов с головы (ERROR_MAX в host.controller.ts), а сообщение от
 * `docker build` со stderr эти 2000 символов выбирает целиком. Приписанные в
 * хвост остатки при таком сообщении не доедут никогда — то есть самое важное
 * («слаг и порт не свободны, повтор упрётся в занятое имя») терялось бы ровно
 * в тех случаях, когда оно нужно.
 */
function describeFailure(e: any, job: HostJob): string {
  const message = (e?.message ? String(e.message) : String(e)).trim();
  const leftovers: string[] = Array.isArray(e?.leftovers) ? e.leftovers : [];
  const body = message || 'провижининг отказал без сообщения';
  const text = leftovers.length ? `НА ХОСТЕ ОСТАЛОСЬ: ${leftovers.join('; ')}\n${body}` : body;
  return redact(text, job);
}

/**
 * Вычищает секреты из текста, который уедет на сервер.
 *
 * Не перестраховка, а измеренный факт: `execFile` кладёт в `message` всю
 * командную строку целиком. Проверено (node 20):
 *
 *     Command failed: /bin/sh -c exit 3 -- -e SECRET=hunter2
 *
 * То есть отказавший `docker run` отдаёт сообщение, где стоят подряд секреты
 * клиента, открытый `RUNNER_TOKEN` и — хуже всего — НАШ
 * `CLAUDE_CODE_OAUTH_TOKEN`, один на все продукты. Черновик отправлял это
 * `e.message` в `complete` как есть, а сервер кладёт причину в
 * `products.provision_error` и показывает её в карточке. Один неудачный
 * `docker run` — и токен подписки лежит в базе открытым текстом и на экране у
 * клиента.
 *
 * Правила два, и они дополняют друг друга:
 *
 *  1. известные значения (токен раннера и секреты задания) вырезаются целиком —
 *     это ловит многострочные значения (приватный ключ в PEM) и появление
 *     значения где угодно в тексте, не только в argv. Короче восьми символов не
 *     трогаем: вырезание двухбуквенного значения превратило бы диагностику в
 *     кашу, а сам такой секрет всё равно закрыт правилом 2;
 *  2. всё после `-e ИМЯ=` в командной строке — это ловит то, чего мы здесь не
 *     знаем: токен Claude читается на хосте и в задании его нет.
 */
export function redact(text: string, job: HostJob): string {
  let out = text;
  const known = [job.runnerToken, ...Object.values(job.secrets ?? {})];
  for (const value of known) {
    // split/join, а не RegExp: значение — произвольная строка, и `.` или `|`
    // внутри неё превратили бы маску в шаблон, вырезающий чужой текст.
    if (typeof value === 'string' && value.length >= 8) out = out.split(value).join('***');
  }
  return out.replace(/(^|\s)(-e|--env)(\s+)([A-Za-z_][A-Za-z0-9_]*)=\S*/g, '$1$2$3$4=***');
}

/**
 * Доставляет отчёт. Возвращает, доехал ли он.
 *
 * НЕ меняет исход — ни при каком отказе доставки. См. шапку файла: отчёт об
 * успехе, превращённый в отказ, хоронит живой продукт.
 *
 * `complete` обёрнут в try, хотя `HostApi.complete` и сам не бросает: здесь
 * подменяемая зависимость, и единственная неперехваченная ошибка из неё
 * поднялась бы через tick в цикл и убила процесс агента. Снаружи это выглядит
 * как «продукты перестали заводиться», а в карточке — как истёкший срок.
 */
export async function deliver(job: HostJob, report: JobReport, deps: HostDeps): Promise<boolean> {
  const wait = deps.sleep ?? sleep;
  const log = deps.log ?? console.log;
  const attempts = deps.config.reportAttempts;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let ok = false;
    try {
      ok = await deps.api.complete(job.jobId, report);
    } catch (e: any) {
      ok = false;
      log(`[host] отчёт ${job.jobId}: попытка ${attempt} бросила (${e?.message ?? e})`);
    }
    if (ok) return true;
    log(`[host] отчёт ${job.jobId} не принят (попытка ${attempt} из ${attempts})`);
    // Пауза только МЕЖДУ попытками: сон после последней задерживал бы
    // следующее задание ни за чем.
    if (attempt < attempts) await wait(deps.config.reportRetryMs);
  }
  return false;
}

/**
 * Бесконечный цикл с условием выхода — ради теста, а не ради гибкости:
 * `for (;;)` не проверить ничем, и в черновике он был единственным местом, где
 * жила пауза и обработка отказов.
 *
 * Здесь же стоит последний перехват. `tick` намеренно НЕ заворачивает
 * `api.poll` в try: наш клиент не бросает по построению, и глушить там —
 * значит прятать настоящую ошибку. Но зависимости подменяемы, а цена
 * единственного промаха — мёртвый агент на машине с чужими продуктами, поэтому
 * страховка обязана быть хотя бы одна, и она здесь. Пауза после сбоя
 * обязательна по той же причине, что и после неудачного опроса: без неё
 * повторяющаяся ошибка превращается в горячий цикл.
 */
export async function loop(deps: HostDeps, keepGoing: () => boolean = () => true): Promise<void> {
  const wait = deps.sleep ?? sleep;
  const log = deps.log ?? console.log;

  while (keepGoing()) {
    try {
      await tick(deps);
    } catch (e: any) {
      log(`[host] оборот сорвался, цикл продолжается: ${e?.message ?? e}`);
      await wait(deps.config.pollIntervalMs * 3);
    }
  }
}

/**
 * Настройки хостовых шагов, вычисляемые из конфига агента.
 *
 * `linkeonUrl` прокидывается НЕ для красоты. Умолчание в provision.ts —
 * `https://my.linkeon.io`, и без этой строки агент на тестовом стенде
 * опрашивал бы test.linkeon.io, а поднятые им продукты уезжали бы за работой
 * на ПРОД с тестовым токеном раннера: контейнер живой, /health зелёный, домен
 * отвечает, а ходы не доезжают — отказ, который видно только по тому, что
 * продукт молчит.
 */
export function provisionOverrides(
  config: HostConfig,
  log: (message: string) => void = console.log,
): Partial<ProvisionDeps> {
  return {
    linkeonUrl: config.linkeonUrl,
    onPhase: (message: string) => log(`[host] ${message}`),
  };
}

/** Боевая сборка зависимостей. В черновике плана её не было вовсе. */
export function realDeps(config: HostConfig): HostDeps {
  const log = (message: string) => console.log(message);
  return {
    config,
    api: new HostApi(config),
    provision: (job: HostJob) => provisionReal(job, hostDeps(provisionOverrides(config, log))),
    log,
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  console.log(
    `[host] старт агента, Linkeon ${config.linkeonUrl}, опрос раз в ${config.pollIntervalMs} мс`,
  );
  await loop(realDeps(config));
}

// Запускаем только когда файл исполняется напрямую: при импорте из теста
// бесконечный цикл стартовать не должен.
if (require.main === module) {
  // Отказ здесь — это только отказ конфига (loop не бросает): без
  // LINKEON_URL или HOST_TOKEN агент не стартует, и причина обязана попасть в
  // журнал. Молчаливый выход по `void main()` дал бы systemd успешное
  // завершение и остановленный юнит без единой строки.
  main().catch((e) => {
    console.error(`[host] фатально: ${e?.message ?? e}`);
    process.exit(1);
  });
}
