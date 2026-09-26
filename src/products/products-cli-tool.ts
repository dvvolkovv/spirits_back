import type { ClaudeCliMcpHttpServer } from '../common/services/claude-cli.service';
import { ProductToolChannel, signProductToolToken } from './product-tool.token';
import { PRODUCT_TOOL_WAIT_MS } from '../common/relay-budget';

/**
 * Инструмент продуктов для ЛОКАЛЬНОГО claude CLI — Маши в вебе и
 * Telegram-бота. Веб-ассистенты получают тот же инструмент через релей
 * (products-relay-fields.ts); здесь CLI запускает сам бэкенд, поэтому MCP-сервер
 * — тот же /webhook/mcp/products — берётся по loopback: ходить к себе через
 * nginx незачем, и адрес не зависит от того, есть ли у среды блок `location`.
 *
 * Чистая функция, а не метод сервиса, — по той же причине, что и у релейных
 * полей: необязательная зависимость в конструкторе молча выключила бы
 * инструмент при ошибке в модуле.
 */

/**
 * Ключ сервера в конфиге. CLI складывает имя инструмента как
 * mcp__<ключ>__<имя из контракта>; то же имя стоит в релее (PRODUCTS_TOOLS в
 * relay-agent/server.mjs). Разъедутся — allowedTools не совпадёт с
 * реальностью, и вызов молча отклонится.
 */
const SERVER_KEY = 'products';

/** Имя инструмента для allowedTools. Сверено тестом с PRODUCT_TOOL_NAME. */
export const PRODUCTS_CLI_TOOL_NAME = `mcp__${SERVER_KEY}__manage_product`;

/**
 * Потолок одного вызова инструмента для CLI — поле `timeout` http-сервера
 * (схема CLI 2.1.280: мс, перекрывает MCP_TOOL_TIMEOUT, меньше 1000
 * игнорируется, прогресс его не продлевает). Проба 26.09.2026: с timeout 20000
 * вызов, ждавший 75 с, оборван «timed out after 20s»; без поля тот же вызов
 * дождался. Правка ждёт исхода до PRODUCT_TOOL_WAIT_MS; минута сверху — на
 * запросы к базе и ответ. Это страховка от зависшего бэкенда: у хода бота
 * своего таймаута нет вовсе, и без потолка он висел бы вместе с вызовом.
 */
export const PRODUCTS_CLI_TOOL_TIMEOUT_MS = PRODUCT_TOOL_WAIT_MS + 60_000;

/**
 * Блок системного промпта. Взят из PRODUCTS_PROMPT релея без его оговорки про
 * «исключение из правила только mcp__linkeon__*»: такого правила у Маши и у
 * бота нет, и фраза про исключение лишь сбивала бы модель. Упоминания Bash/Write
 * тоже нет — в локальном CLI этих тулов нет.
 */
export const PRODUCTS_CLI_PROMPT = `ПРОДУКТЫ ПОЛЬЗОВАТЕЛЯ (сайты и телеграм-боты, размещённые в Линкеоне).
Тебе доступен инструмент ${PRODUCTS_CLI_TOOL_NAME}.
НЕ передавай в него userId/телефон — их там нет: сервер уже знает, чей это разговор.
- { action: "list" } — показать продукты пользователя.
- { action: "edit", product: "<как пользователь назвал>", prompt: "<что сделать, подробно>" } — поставить правку.
- { action: "status", product или turnId } — узнать, чем кончилась правка.
- { action: "domain", product, domain: "<домен пользователя>" } — привязать свой домен к сайту; { action: "domain", product } — узнать, как дела; { action: "domain", product, check: true } — проверить DNS сейчас; { action: "domain", product, remove: true } — отвязать.
  Записи DNS из ответа называй ДОСЛОВНО и обязательно скажи удалить у этих имён остальные A-записи и ВСЕ AAAA. Не говори «домен работает», пока domain.status не "active". Свой домен бесплатный. Свой домен бывает только у сайта, один на продукт.
Каждый ответ инструмента несёт поле say — что сказать пользователю. Следуй ему: пересказывай его, не выдумывай своё.
Если пользователь просит что-то изменить на его сайте или в его боте — это делается ЭТИМ инструментом.
У тебя нет доступа к файлам его продукта: правку исполняет ассистент внутри продукта.
ГЛАВНОЕ: outcome="reverted" значит ОТКАТ — правка НЕ применена, код вернули как было. Никогда не называй это «готово» или «сделал». outcome="failed" — тоже не успех. Успех только outcome="done".
Если вернулось reason="ambiguous" — СПРОСИ, какой продукт править, и вызови снова. Не выбирай сам.`;

export interface ProductsCliMcp {
  /** Для ClaudeCliOptions.mcpServers: токен уезжает в файл 0600, не в argv. */
  mcpServers: Record<string, ClaudeCliMcpHttpServer>;
  /** Для allowedTools: без него вызов в -p отклоняется. */
  toolName: string;
  /** Для системного промпта. */
  promptBlock: string;
}

/**
 * Всё, что нужно одному вызову CLI, чтобы у ассистента был инструмент
 * продуктов пользователя `userId`. Токен чеканится на каждый вызов (живёт 30
 * минут — дольше любого хода) и несёт канал: правка из Telegram ляжет в
 * product_turns с channel='telegram'.
 *
 * Порт — тот же `process.env.PORT || 3001`, на котором слушает приложение
 * (main.ts); путь — /webhook/mcp/products: исключение глобального префикса
 * покрывает только точный путь `mcp` (см. products-mcp.controller.ts).
 */
export function productsCliMcp(userId: string, channel: ProductToolChannel): ProductsCliMcp {
  const port = process.env.PORT || 3001;
  return {
    mcpServers: {
      [SERVER_KEY]: {
        type: 'http',
        url: `http://127.0.0.1:${port}/webhook/mcp/products`,
        headers: { Authorization: `Bearer ${signProductToolToken(userId, channel)}` },
        timeout: PRODUCTS_CLI_TOOL_TIMEOUT_MS,
      },
    },
    toolName: PRODUCTS_CLI_TOOL_NAME,
    promptBlock: PRODUCTS_CLI_PROMPT,
  };
}
