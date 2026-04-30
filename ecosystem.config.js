// =============================================================================
// PM2 ecosystem для Meowbox.
//
// Поддерживает ДВЕ раскладки одновременно:
//   1) Legacy:  /opt/meowbox/{api,agent,web}/dist/...      (рабочая до перевода)
//   2) Release: /opt/meowbox/current → releases/<v>/{api,agent,web}/dist/...
//                + state/ для persistent данных (БД, .env, logs)
//
// Авто-детект: если есть симлинк `current` → используем его, иначе legacy.
// PM2 при reload перечитает этот файл и подхватит изменившийся target симлинка
// (см. tools/update.sh, шаг switch).
//
// КРИТИЧНО: при переезде на release-раскладку этот файл становится статичным
// и НЕ копируется в releases/<v>/ — он указывает на содержимое релиза через
// `current` симлинк, поэтому пути остаются стабильными после `pm2 reload`.
// =============================================================================

const fs = require('fs');
const path = require('path');

// --- 1) Резолвим источник кода: current/ или legacy /opt/meowbox/ ---
//
// Файл может загружаться из двух мест:
//  (a) /opt/meowbox/ecosystem.config.js (legacy или симлинк → current/...)
//      → __dirname после Node-резолва симлинков становится
//        /opt/meowbox/releases/<v>/, что НЕ panel root.
//  (b) /opt/meowbox/ecosystem.config.js напрямую как файл (legacy git-checkout)
//      → __dirname = /opt/meowbox/.
//
// Эвристика: если __dirname лежит внутри releases/<v>/, walk up на 2 уровня
// и получаем настоящий panel root (там должны быть releases/ и state/).
function resolvePanelDir() {
  const dir = __dirname;
  const parent = path.dirname(dir);
  if (path.basename(parent) === 'releases') {
    return path.dirname(parent);
  }
  return dir;
}
const PANEL_DIR = process.env.MEOWBOX_PANEL_DIR_OVERRIDE || resolvePanelDir();
const CURRENT_LINK = path.join(PANEL_DIR, 'current');
const HAS_CURRENT = (() => {
  try {
    const st = fs.lstatSync(CURRENT_LINK);
    if (!st.isSymbolicLink() && !st.isDirectory()) return false;
    // Проверяем, что внутри есть собранный код API.
    return fs.existsSync(path.join(CURRENT_LINK, 'api', 'dist', 'main.js'));
  } catch {
    return false;
  }
})();
const CODE_DIR = HAS_CURRENT ? CURRENT_LINK : PANEL_DIR;

// --- 2) Резолвим state/: persistent runtime (БД, .env, logs) ---
//     В release-раскладке это `state/`, в legacy — корень панели.
const STATE_DIR = (() => {
  const stateDir = path.join(PANEL_DIR, 'state');
  if (fs.existsSync(stateDir)) return stateDir;
  return PANEL_DIR;
})();
const ENV_FILE = path.join(STATE_DIR, '.env');
const FALLBACK_ENV = fs.existsSync(ENV_FILE) ? ENV_FILE : path.join(PANEL_DIR, '.env');

// --- 3) Грузим .env ---
function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    val = val.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[m[1]] = val;
  }
  return out;
}

const envVars = loadEnv(FALLBACK_ENV);
const API_PORT = envVars.API_PORT || '11860';
const WEB_PORT = envVars.WEB_PORT || '11861';
const AGENT_SECRET = envVars.AGENT_SECRET || '';
const API_HOST = envVars.API_HOST || '127.0.0.1';
const INTERNAL_TOKEN =
  envVars.INTERNAL_TOKEN && envVars.INTERNAL_TOKEN !== AGENT_SECRET
    ? envVars.INTERNAL_TOKEN
    : '';
const API_URL = `http://${API_HOST === '0.0.0.0' ? '127.0.0.1' : API_HOST}:${API_PORT}`;

// --- 4) Общие env для всех приложений ---
const COMMON_ENV = {
  NODE_ENV: 'production',
  // Передаём абсолютные пути, чтобы приложения могли найти persistent data:
  MEOWBOX_PANEL_DIR: PANEL_DIR,
  MEOWBOX_STATE_DIR: STATE_DIR,
  // dotenv внутри API смотрит на envFilePath: '../.env' относительно cwd → подменяем.
  DOTENV_PATH: FALLBACK_ENV,
};

module.exports = {
  apps: [
    {
      name: 'meowbox-api',
      cwd: path.join(CODE_DIR, 'api'),
      script: path.join(CODE_DIR, 'api', 'dist', 'main.js'),
      instances: 1,
      max_memory_restart: '256M',
      env: {
        ...COMMON_ENV,
        API_PORT,
        API_HOST,
        INTERNAL_TOKEN,
      },
      watch: false,
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
    },
    {
      name: 'meowbox-agent',
      cwd: path.join(CODE_DIR, 'agent'),
      script: path.join(CODE_DIR, 'agent', 'dist', 'main.js'),
      instances: 1,
      max_memory_restart: '512M',
      env: {
        ...COMMON_ENV,
        AGENT_SECRET,
        API_URL,
      },
      watch: false,
      kill_timeout: 30000,
    },
    {
      name: 'meowbox-web',
      cwd: path.join(CODE_DIR, 'web'),
      script: path.join(CODE_DIR, 'web', '.output', 'server', 'index.mjs'),
      instances: 1,
      max_memory_restart: '256M',
      env: {
        ...COMMON_ENV,
        NITRO_PORT: WEB_PORT,
        NITRO_HOST: '127.0.0.1',
        API_HOST,
        API_PORT,
        INTERNAL_TOKEN,
      },
      watch: false,
      kill_timeout: 5000,
    },
  ],
};
