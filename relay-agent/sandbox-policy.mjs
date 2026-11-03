// Политика песочницы для ходов релея (спека 2026-11-03-relay-bash-sandbox-design.md).
// Чистая логика — без зависимостей от server.mjs; читаемое извне: режим из файла,
// канареечный список, сбор --settings, чистое окружение CLI.
import fs from 'node:fs';

export const AGENT_OPT_DIR = '/opt/linkeon-agent';
export const AGENT_SCRATCH_ROOT = '/tmp/agent-scratch';
export const AGENT_MCP_DIR = '/tmp/agent-mcp';
export const SANDBOX_SCHEMA = process.env.RELAY_SANDBOX_SCHEMA || 'A'; // подтверждено разведкой 03.11

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
    return fs.readFileSync(keysFile, 'utf8').split('\n').map((s) => s.trim()).includes(sessionKey);
  } catch {
    return false;
  }
}

// Настройки для --settings <файл>. Пути с '<fs_key>' — подставить ключ до записи.
export function buildSandboxSettings(fsKey, { scratch, mcpDir } = {}) {
  const scratchDir = scratch || `${AGENT_SCRATCH_ROOT}/${fsKey}`;
  const myOutput = `/tmp/agent-output/${fsKey}`;
  const deny = ['/home/dv', '/etc/sudoers', '/etc/sudoers.d', mcpDir || AGENT_MCP_DIR];
  const PROXY = process.env.RELAY_SANDBOX_PROXY || '127.0.0.1:8471';
  const net = SANDBOX_SCHEMA === 'A'
    ? { network: { allowedDomains: [PROXY] } }
    : {};
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['sudo *'],
      filesystem: {
        allowWrite: [scratchDir, myOutput],
        denyRead: [...deny, scratchDir === '/tmp/agent-scratch/<fs_key>' ? '/tmp/agent-scratch' : AGENT_SCRATCH_ROOT],
      },
      ...net,
    },
    permissions: {
      deny: [
        ...deny.map((d) => `Read(${d}/**)`),
        ...deny.map((d) => `Glob(${d}/**)`),
        ...deny.map((d) => `Grep(${d}/**)`),
        ...deny.map((d) => `Write(${d}/**)`),
        ...deny.map((d) => `Edit(${d}/**)`),
      ],
    },
  };
}

// Окружение CLI: белый список + переменные выбранного провайдера + scrub.
// GEMINI_API_KEY/OPENROUTER_API_KEY не пробрасываются (ни релею, ни ассистентам не нужны).
const ENV_PASS = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT', 'RUN_ENV']);

export function buildCliEnv({ baseEnv, providerEnv, fsKey, scrub }) {
  const env = {};
  for (const k of ENV_PASS) if (baseEnv[k] !== undefined) env[k] = baseEnv[k];
  Object.assign(env, providerEnv || {}); // ANTHROPIC_* выбранного провайдера
  const scratchDir = `${AGENT_SCRATCH_ROOT}/${fsKey}`;
  env.HOME = scratchDir;
  env.TMPDIR = scratchDir;
  env.CLAUDE_CONFIG_DIR = '/home/dv/.claude';
  if (scrub) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  env.PATH = `${AGENT_OPT_DIR}/bin:/usr/local/bin:/usr/bin:/bin`;
  // Сеть — только через локальный прокси (squid на релее режет внутренние
  // назначения). no_proxy НЕ задаём: он дал бы обход резки через localhost.
  const PROXY = process.env.RELAY_SANDBOX_PROXY || '127.0.0.1:8471';
  env.http_proxy = `http://${PROXY}`;
  env.https_proxy = `http://${PROXY}`;
  env.HTTP_PROXY = env.http_proxy;
  env.HTTPS_PROXY = env.https_proxy;
  return env;
}
