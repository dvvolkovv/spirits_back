/**
 * Каркас нового продукта: что именно кладётся в чекаут при заведении.
 *
 * Каркас сайта перенесён дословно из `scripts/product-provision.sh` (блоки
 * `cat > package.json`, `cat > server.js`, `cat > CLAUDE.md`) — он обкатан на
 * двух живых продуктах. Единственная правка: переменная `SHA` переименована в
 * `GIT_SHA`, чтобы обе формы назывались одинаково и проверялись одним тестом.
 *
 * Каркас бота отличается тремя вещами: нет публикуемого порта, нет vhost, нет
 * домена. Здоровье слушает 127.0.0.1 внутри контейнера, обновления забираются
 * long polling'ом; `setWebhook` не вызывается — общий токен между средами уже
 * уводил боевого бота.
 *
 * Имя продукта задаёт клиент, а возвращённый отсюда текст уезжает на живую
 * машину и становится там кодом (`server.js`), конфигом (`package.json`) и
 * инструкцией ассистенту (`CLAUDE.md`). Три разных контекста экранирования —
 * поэтому имя проходит через три разные чистки, а не через одну общую.
 */

export type ProductKind = 'site' | 'bot';

/** Заголовок, если от имени после чистки ничего не осталось. */
const FALLBACK_TITLE = 'Новый продукт';

/** Имя npm-пакета, если из названия не осталось ни одного годного символа. */
const FALLBACK_PACKAGE = 'linkeon-product';

/**
 * Одна строка без управляющих символов.
 *
 * Общее у всех трёх контекстов одно: перевод строки выводит имя за пределы
 * отведённого ему места. В `server.js` это буквально исполняемый код после
 * `//`; в `CLAUDE.md` — дописанный раздел в инструкции ассистенту, которым
 * можно снять запрет на запуск сервера руками.
 *
 * U+2028 и U+2029 вычищаются наравне с `\n`: JavaScript считает их концом
 * строки, а в диффе они не видны.
 */
function oneLine(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Имя для комментария JavaScript. Комментарий строчный, так что достаточно
 * одной строки; закрывающая последовательность блочного комментария всё равно
 * обезвреживается — на случай, если комментарий когда-нибудь станет блочным.
 */
function forJsComment(raw: string): string {
  return oneLine(raw).replace(/\*\//g, '* /') || FALLBACK_TITLE;
}

/**
 * Имя для заголовка markdown. Экранируются символы, которыми можно подменить
 * разметку инструкции: решётка (заголовок), бэктик (код-спан и фенс), угловые
 * скобки (сырой HTML), скобки и звёздочки (ссылки и выделение).
 */
function forMarkdown(raw: string): string {
  const escaped = oneLine(raw).replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);
  return escaped || FALLBACK_TITLE;
}

/**
 * Имя npm-пакета.
 *
 * Слаг продукта сюда не доезжает: `skeletonFor(kind, name)` получает только
 * отображаемое имя (так его зовёт `provision.ts`), а `npm` отвергает пробелы,
 * заглавные буквы, не-ASCII, ведущую точку или подчёркивание и длину больше
 * 214. Русское название стирается чисткой целиком — поэтому нужен запасной
 * вариант: `"name": ""` невалиден ровно так же, как кириллица, и обнаружится
 * это на `npm ci` уже на машине клиента.
 */
function forNpmName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 214)
    .replace(/-+$/g, '');
  return slug || FALLBACK_PACKAGE;
}

/**
 * `package.json` собирается через `JSON.stringify`, а не склейкой строк:
 * кавычка и обратный слэш в названии продукта — обычный ввод из кабинета, а
 * не экзотика, и на склейке они дают невалидный JSON.
 */
function packageJson(name: string): string {
  const pkg = {
    name: forNpmName(name),
    version: '1.0.0',
    private: true,
    description: oneLine(name) || FALLBACK_TITLE,
    scripts: {
      // PRODUCT_START_SCRIPT=server.js и `pm2 restart product` в контейнере
      // рассчитывают ровно на эту точку входа.
      start: 'node server.js',
      build: 'echo nothing to build',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function siteServerJs(name: string): string {
  return `// ${forJsComment(name)} — сайт под управлением ассистента Linkeon.
const http = require('http');
const { execSync } = require('child_process');
const PORT = process.env.PORT || 3000;

// sha вычисляется ОДИН РАЗ при старте и дальше не перечитывается.
// Это не оптимизация: по нему раннер отличает «поднялся новый код» от
// «на порту остался процесс прошлой версии». Читать на каждый запрос —
// значит позволить сироте отдать свежий sha и подделать выкат.
const GIT_SHA = (() => {
  try { return execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); }
  catch { return 'unknown'; }
})();
const page = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Новый продукт</title></head>'
  + '<body><h1>Новый продукт</h1><p>Этот сайт правит ассистент Linkeon.</p></body></html>';
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true, sha:GIT_SHA})); }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
  res.end(page);
}).listen(PORT);
`;
}

function botServerJs(name: string): string {
  return `// ${forJsComment(name)} — телеграм-бот под управлением ассистента Linkeon.
const http = require("http");
const { execFileSync } = require("child_process");

// Один раз при старте: по этому полю раннер отличает поднявшийся новый код от
// процесса прошлой версии, оставшегося на порту.
const GIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
const TOKEN = process.env.BOT_TOKEN;

// Здоровье слушает 127.0.0.1: наружу боту торчать нечем и незачем, а раннер
// внутри контейнера дотянется.
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, sha: GIT_SHA }));
}).listen(3000, "127.0.0.1");

// Long polling. setWebhook не используется: общий токен между средами уже
// уводил боевого бота.
let offset = 0;
async function loop() {
  for (;;) {
    try {
      const r = await fetch(\`https://api.telegram.org/bot\${TOKEN}/getUpdates?timeout=30&offset=\${offset}\`);
      const d = await r.json();
      for (const u of d.result ?? []) {
        offset = u.update_id + 1;
        if (u.message?.text) {
          await fetch(\`https://api.telegram.org/bot\${TOKEN}/sendMessage\`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: u.message.chat.id, text: "Бот заведён и ждёт правок." }),
          });
        }
      }
    } catch (e) {
      // Обрыв связи с Telegram не должен ронять процесс: health обязан
      // продолжать отвечать, иначе ход откатится из-за чужой сетевой ошибки.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
loop();
`;
}

function siteClaudeMd(name: string): string {
  return `# ${forMarkdown(name)}

Сайт на голом node. Правится ассистентом Linkeon.

## Где что
- \`server.js\` — весь сайт, точка входа
- Порт берётся из \`PORT\`, менять нельзя: снаружи на него смотрит nginx
- \`/health\` отдаёт \`{"ok":true,"sha":"<хеш коммита>"}\` — по нему проверяется,
  что поднялся именно новый код. Хеш считается один раз при старте процесса;
  читать его на каждый запрос нельзя, иначе проверка перестаёт что-либо значить

## Как это работает
Продукт живёт в контейнере под PM2, процесс называется \`product\`.
После правки: \`npm run build\`, затем \`pm2 restart product\`.

## Что не трогать
\`/health\` обязан отвечать 200, JSON и поле \`sha\`. Если он сломается или
перестанет отдавать sha, ход откатится автоматически, а правка потеряется.

## Чего не делать во время правки
Не запускать сервер руками (\`node server.js\`, \`npm start\` в фоне). Процесс
переживёт твой ход, займёт порт, и все последующие выкаты будут падать с
EADDRINUSE — при этом сайт продолжит отвечать старым кодом. Перезапуском
занимается раннер: \`pm2 restart product\`.
`;
}

function botClaudeMd(name: string): string {
  return `# ${forMarkdown(name)}

Телеграм-бот на голом node. Правится ассистентом Linkeon.

## Где что
- \`server.js\` — весь бот, точка входа
- Токен лежит в переменной окружения \`BOT_TOKEN\`, в код его не класть
- Обновления забираются long polling'ом (\`getUpdates\`). \`setWebhook\` не звать:
  один и тот же токен в двух средах уже уводил боевого бота
- \`/health\` слушает \`127.0.0.1:3000\` внутри контейнера и отдаёт
  \`{"ok":true,"sha":"<хеш коммита>"}\` — по нему проверяется, что поднялся
  именно новый код. Хеш считается один раз при старте процесса; читать его на
  каждый запрос нельзя, иначе проверка перестаёт что-либо значить

## Как это работает
Продукт живёт в контейнере под PM2, процесс называется \`product\`.
После правки: \`npm run build\`, затем \`pm2 restart product\`.
Наружу бот не публикует ничего: снаружи его не видно и видно быть не должно.

## Что не трогать
\`/health\` обязан отвечать 200, JSON и поле \`sha\`. Если он сломается или
перестанет отдавать sha, ход откатится автоматически, а правка потеряется.
Обрыв связи с Telegram гасить внутри цикла: упавший процесс уносит с собой и
health, и тогда ход откатится из-за чужой сетевой ошибки.

## Чего не делать во время правки
Не запускать сервер руками (\`node server.js\`, \`npm start\` в фоне). Процесс
переживёт твой ход, займёт порт 3000, и все последующие выкаты будут падать с
EADDRINUSE — при этом бот продолжит отвечать старым кодом. Перезапуском
занимается раннер: \`pm2 restart product\`.
`;
}

/**
 * Файлы первичного каркаса продукта: имя файла → содержимое.
 *
 * Возвращённое отсюда провижининг пишет в чекаут и сразу коммитит, так что
 * набор файлов — это первый коммит продукта.
 */
export function skeletonFor(kind: ProductKind, name: string): Record<string, string> {
  return {
    'package.json': packageJson(name),
    'server.js': kind === 'bot' ? botServerJs(name) : siteServerJs(name),
    'CLAUDE.md': kind === 'bot' ? botClaudeMd(name) : siteClaudeMd(name),
  };
}
