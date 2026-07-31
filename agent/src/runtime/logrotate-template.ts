const RUNTIME_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface PhpLogrotateRuntime {
  readonly runtimeKey: string;
  readonly systemUser?: string | null;
}

export function renderNginxLogrotate(): string {
  return `/var/log/nginx/*-access.log /var/log/nginx/*-error.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    create 0640 www-data adm
    sharedscripts
    postrotate
        test ! -s /run/nginx.pid || kill -USR1 \`cat /run/nginx.pid\`
    endscript
}
`;
}

export function renderPhpLogrotate(runtimes: ReadonlyArray<PhpLogrotateRuntime>): string {
  const unique = new Map<string, string>();
  for (const runtime of runtimes) {
    const runtimeKey = runtime.runtimeKey.trim();
    const user = runtime.systemUser?.trim() || 'www-data';
    if (!RUNTIME_KEY_RE.test(runtimeKey)) throw new Error(`Invalid PHP log runtimeKey "${runtime.runtimeKey}"`);
    if (!LINUX_USER_RE.test(user)) throw new Error(`Invalid PHP log owner "${user}"`);
    const prior = unique.get(runtimeKey);
    if (prior && prior !== user) throw new Error(`PHP log runtimeKey ${runtimeKey} has conflicting owners`);
    unique.set(runtimeKey, user);
  }

  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runtimeKey, user]) => `/var/log/php/${runtimeKey}-error.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    create 0640 ${user} adm
}
`)
    .join('\n');
}
