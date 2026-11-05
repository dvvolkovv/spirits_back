// Политика песочницы для ходов релея (спека 2026-11-03-relay-bash-sandbox-design.md).
// Чистая логика — без зависимостей от server.mjs; читаемое извне: режим из файла,
// канареечный список, сбор --settings, чистое окружение CLI.
import fs from 'node:fs';

export const AGENT_OPT_DIR = '/opt/linkeon-agent';
export const AGENT_SCRATCH_ROOT = '/tmp/agent-scratch';
export const AGENT_MCP_DIR = '/tmp/agent-mcp';
export const SANDBOX_SCHEMA = process.env.RELAY_SANDBOX_SCHEMA ?? 'A'; // подтверждено разведкой 03.11
export const SANDBOX_ALLOWED_DOMAINS = Object.freeze([
  'example.com',
  'my.linkeon.io',
  'pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
  'nodejs.org',
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'image.pollinations.ai',
  'fonts.google.com',
  'fonts.gstatic.com',
]);

// Режим из файла на сервере (~/file-agent/sandbox-mode). Битый/отсутствующий — off.
export function sandboxMode(modeFile) {
  try {
    const v = fs.readFileSync(modeFile, 'utf8').trim();
    return v === 'on' || v === 'canary' ? v : 'off';
  } catch {
    return 'off';
  }
}

// Канарейка: только сессии, чьи ключи есть в файле списка (по строке).
export function isCanarySession(sessionKey, mode, keysFile) {
  if (mode === 'on') return true;
  if (mode !== 'canary') return false;
  try {
    return fs.readFileSync(keysFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).includes(sessionKey);
  } catch {
    return false;
  }
}

function validateFsKey(fsKey) {
  if (typeof fsKey !== 'string' || !/^[A-Za-z0-9._-]+$/.test(fsKey) || fsKey === '.' || fsKey === '..') {
    throw new TypeError('invalid fsKey');
  }
}

function normalizeDir(dir) {
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed || '/';
}

// Настройки для --settings <файл>. Пути с '<fs_key>' — подставить ключ до записи.
export function buildSandboxSettings(fsKey, {
  scratch, mcpDir, schema = SANDBOX_SCHEMA, outputRoot = '/tmp/agent-output',
} = {}) {
  validateFsKey(fsKey);
  if (schema !== 'A') throw new TypeError("RELAY_SANDBOX_SCHEMA must be 'A'");
  const scratchDir = normalizeDir(scratch || `${AGENT_SCRATCH_ROOT}/${fsKey}`);
  const myOutput = `${normalizeDir(outputRoot)}/${fsKey}`;
  // Второй MCP-путь — прежний каталог внутри uploads. Его физическая очистка —
  // отдельный этап; здесь он закрыт и на чтение, и на запись независимо от mcpDir.
  const deny = [...new Set([
    '/home/dv', '/proc', '/etc/sudoers', '/etc/sudoers.d',
    normalizeDir(mcpDir || AGENT_MCP_DIR), '/tmp/agent-uploads/mcp',
  ])];
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['sudo *'],
      filesystem: {
        allowWrite: [scratchDir, myOutput],
        denyRead: [...deny],
      },
      network: { allowedDomains: [...SANDBOX_ALLOWED_DOMAINS] },
    },
    permissions: {
      deny: [
        ...deny.map((d) => `Read(${d}/**)`),
        ...deny.map((d) => `Edit(${d}/**)`),
      ],
    },
  };
}

// Окружение CLI: белый список + переменные выбранного провайдера + scrub.
// GEMINI_API_KEY/OPENROUTER_API_KEY не пробрасываются (ни релею, ни ассистентам не нужны).
const ENV_PASS = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT', 'RUN_ENV']);
const PROVIDER_ENV_PASS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]);

export function buildCliEnv({
  baseEnv, providerEnv, fsKey, scrub,
  scratchRoot = AGENT_SCRATCH_ROOT, optDir = AGENT_OPT_DIR,
  claudeConfigDir = '/home/dv/.claude',
}) {
  validateFsKey(fsKey);
  const env = {};
  for (const k of ENV_PASS) if (baseEnv[k] !== undefined) env[k] = baseEnv[k];
  for (const [k, v] of Object.entries(providerEnv || {})) {
    if (k.startsWith('ANTHROPIC_') || PROVIDER_ENV_PASS.has(k)) env[k] = v;
  }
  const scratchDir = `${normalizeDir(scratchRoot)}/${fsKey}`;
  env.HOME = scratchDir;
  env.TMPDIR = scratchDir;
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.MCP_TIMEOUT = '120000';
  env.MCP_TOOL_TIMEOUT = '600000';
  if (scrub) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  env.PATH = `${normalizeDir(optDir)}/bin:/usr/local/bin:/usr/bin:/bin`;
  // Сетевой белый список применяет встроенная песочница CLI; proxy-переменные
  // не задаём и не пробрасываем, включая no_proxy.
  return env;
}

// Встроенные инструменты хода в песочнице. Собственные uploads — по префиксу
// fsKey: это файлы, которые пользователь приложил именно к этому разговору.
// Корни output/uploads/scratch в denyRead намеренно не добавляются: собственные
// пути должны оставаться доступными, а изоляцию дают 0311 на корнях и fsKey.
export function buildSandboxTools(fsKey, {
  outputRoot = '/tmp/agent-output', scratchRoot = AGENT_SCRATCH_ROOT,
  uploadRoot = '/tmp/agent-uploads', optDir = AGENT_OPT_DIR,
} = {}) {
  validateFsKey(fsKey);
  const output = normalizeDir(outputRoot);
  const scratch = normalizeDir(scratchRoot);
  const uploads = normalizeDir(uploadRoot);
  const opt = normalizeDir(optDir);
  const readRoots = [
    `${output}/${fsKey}/**`,
    `${scratch}/${fsKey}/**`,
    `${uploads}/${fsKey}_*`,
    `${opt}/**`, '/usr/**', '/etc/**',
  ];
  const writeRoots = [`${output}/${fsKey}/**`, `${scratch}/${fsKey}/**`];
  return [
    'Bash(*)',
    ...['Read', 'Glob', 'Grep'].flatMap((name) => readRoots.map((root) => `${name}(${root})`)),
    ...['Write', 'Edit'].flatMap((name) => writeRoots.map((root) => `${name}(${root})`)),
    'WebSearch(*)',
  ].join(',');
}

// Единый источник базового списка и при инициализации, и в catch MCP. В off
// legacyTools возвращается дословно, без валидации fsKey или иных побочных эффектов.
export function baseToolsForTurn(fsKey, sandboxOn, legacyTools, options) {
  return sandboxOn ? buildSandboxTools(fsKey, options) : legacyTools;
}

// Окружение spawn: off — ровно объект прежней ветки server.mjs; on — белый
// список buildCliEnv, scrub и служебная метка для уборки потомков хода.
export function buildTurnEnv({
  sandboxOn, legacyEnv, baseEnv, providerEnv, fsKey, tag, runEnvName,
  scratchRoot, optDir, claudeConfigDir,
}) {
  if (!sandboxOn) return legacyEnv;
  const env = buildCliEnv({ baseEnv, providerEnv, fsKey, scrub: true, scratchRoot, optDir, claudeConfigDir });
  env[runEnvName] = tag;
  env.OMP_THREAD_LIMIT = '1';
  return env;
}

// Промпт меняется только у хода в песочнице. В off возвращается та же строка.
export function applySandboxPrompt(prompt, sandboxOn) {
  if (!sandboxOn) return prompt;
  return prompt
    .replace(
      'Full sudo access (no password). Install anything you need.',
      'Bash runs in a sandbox. sudo is unavailable. The server home directory is unavailable. Write only to the output directory and your scratch directory.',
    )
    .replace(
      'INSTALL ANYTHING MISSING: apt, pip, npm, wget — whatever it takes.',
      'INSTALL MISSING PACKAGES: use pip/npm locally in your scratch directory or a venv there; use wget/curl only for allowed domains through the network sandbox. apt and sudo are unavailable.',
    )
    .replaceAll('/home/dv/agent-env/bin/activate', `${AGENT_OPT_DIR}/venv/bin/activate`)
    .replaceAll('/home/dv/agent-env/bin/generate_image.sh', `${AGENT_OPT_DIR}/bin/generate_image.sh`);
}

const SANDBOX_FAILURE_RE = /sandbox|bwrap|no new privileges/i;

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    return block && block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).join('\n');
}

// CLI возвращает результат инструмента событием user/tool_result, а не
// assistant/tool_use. Считаем только результаты Bash, чьи tool_use_id были
// замечены в assistant-событии этого же запуска; сырой текст здесь не журналируется.
export function sandboxFailureFromToolResult(ev, bashToolUseIds) {
  const blocks = ev && ev.type === 'user' && ev.message
    ? ev.message.content
    : ev && ev.type === 'tool_result' ? [ev] : [];
  if (!Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (!block || block.type !== 'tool_result' || !bashToolUseIds.has(block.tool_use_id)) continue;
    if (SANDBOX_FAILURE_RE.test(toolResultText(block.content))) return true;
  }
  return false;
}
