// Управление Node.js-приложениями сайта через PM2.
//
// Источник правды для PM2-процессов — ecosystem-файл(ы) в репозитории сайта.
// Панель их обнаруживает и читает, но НЕ генерирует и НЕ редактирует.
// Быстрые команды (Makefile/package.json) — отдельная сущность, не под PM2.

/** Допустимые источники команд/процессов. */
export const NODE_COMMAND_SOURCES = ['npm', 'make'] as const;
export type NodeCommandSource = (typeof NODE_COMMAND_SOURCES)[number];

/** Конвенциональные имена PM2 ecosystem-файлов. */
export const PM2_ECOSYSTEM_FILENAMES = [
  'ecosystem.config.js',
  'ecosystem.config.cjs',
  'ecosystem.config.json',
  'pm2.config.js',
  'pm2.config.cjs',
  'pm2.config.json',
] as const;

/** Одно приложение из ecosystem-файла PM2 (определение на диске). */
export interface NodeAppDefinition {
  name: string | null;
  script: string | null;
  cwd: string | null;
  interpreter: string | null;
  execMode: string | null;
  instances: number | null;
}

/** Live-состояние процесса из `pm2 jlist`. */
export interface NodeProcessRuntime {
  name: string;
  pmId: number;
  pid: number | null;
  /** online | stopped | errored | launching | stopping | ... */
  status: string;
  /** % CPU. */
  cpu: number;
  /** Память в байтах. */
  memory: number;
  /** Эпоха (ms) старта процесса. */
  uptime: number;
  restarts: number;
  execMode: string | null;
  instances: number | null;
}

/** Объединённое представление процесса для UI: definition ∪ runtime. */
export interface NodeProcessView {
  name: string;
  /** Определён ли в каком-либо ecosystem-файле сайта. */
  defined: boolean;
  /** Загружен ли в PM2-демон (присутствует в `pm2 jlist`). */
  loaded: boolean;
  /** Абсолютный путь к ecosystem-файлу, если defined. */
  ecosystemFile: string | null;
  definition: NodeAppDefinition | null;
  runtime: NodeProcessRuntime | null;
}

/** Группа процессов одного ecosystem-файла (или «сироты» — есть в PM2, нет в файлах). */
export interface NodeEcosystemGroup {
  /** Абс. путь ecosystem-файла; null — группа «сироты». */
  ecosystemFile: string | null;
  /** Путь директории файла относительно web-root сайта (для UI); null для сирот. */
  dir: string | null;
  processes: NodeProcessView[];
}

export interface NodeProcessesResult {
  groups: NodeEcosystemGroup[];
  /** Сколько ecosystem-файлов найдено на диске. */
  ecosystemCount: number;
  /** PM2-демон сайта сейчас запущен. */
  daemonRunning: boolean;
  /** Автозагрузка демона при старте сервера (systemd unit `pm2@<user>`). */
  autostartEnabled: boolean;
}

/** Найденная команда из Makefile / package.json scripts. */
export interface DiscoveredCommand {
  source: NodeCommandSource;
  /** Имя npm-скрипта или make-таргета. */
  target: string;
  /** Превью тела команды (для UI). */
  preview: string | null;
}

/** Группа найденных команд одного файла-источника. */
export interface DiscoveredCommandGroup {
  source: NodeCommandSource;
  /** Абсолютный путь файла-источника. */
  file: string;
  /** Директория файла относительно web-root сайта. */
  dir: string;
  commands: DiscoveredCommand[];
}

/** Сохранённая быстрая команда сайта (блок «Быстрый доступ»). */
export interface QuickCommand {
  id: string;
  label: string;
  source: NodeCommandSource;
  target: string;
  /** Рабочая директория — абсолютный путь. */
  cwd: string;
  sortOrder: number;
}

/** Результат выполнения быстрой команды. */
export interface QuickCommandRunResult {
  exitCode: number;
  output: string;
  durationMs: number;
}
