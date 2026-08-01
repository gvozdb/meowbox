const ZONE_NAME = /^[A-Za-z0-9_-]+$/;

export const NGINX_ZONES_HEADER = [
  '# === Meowbox global rate-limit zones (управляется агентом) ===',
  '# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.',
  '# Не редактируй вручную — изменения будут затёрты.',
].join('\n');

export interface NginxZonesMergeResult {
  content: string;
  declaredCount: number;
  referencedCount: number;
  addedZones: readonly string[];
}

function withoutComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, ''))
    .join('\n');
}

export function collectDeclaredRateLimitZones(content: string): Set<string> {
  const zones = new Set<string>();
  const declaration = /\blimit_req_zone\b[^;]*?\bzone=([A-Za-z0-9_-]+):[^;\s]+[^;]*;/g;
  const active = withoutComments(content);
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(active)) !== null) zones.add(match[1]);
  return zones;
}

export function collectReferencedRateLimitZones(content: string): Set<string> {
  const zones = new Set<string>();
  const reference = /\blimit_req\s+zone=([A-Za-z0-9_-]+)(?=[\s;])/g;
  const active = withoutComments(content);
  let match: RegExpExecArray | null;
  while ((match = reference.exec(active)) !== null) zones.add(match[1]);
  return zones;
}

/**
 * Preserve every existing declaration and append only zones required by the
 * active managed configs. This keeps the bootstrap compatible with both the
 * historical `site_*` layout and the current `mb_*` per-domain layout.
 */
export function mergeRateLimitZones(
  currentContent: string | null,
  referencedZones: Iterable<string>,
  externallyDeclaredZones: Iterable<string> = [],
): NginxZonesMergeResult {
  const current = currentContent ?? '';
  const declared = collectDeclaredRateLimitZones(current);
  const externallyDeclared = new Set(
    [...externallyDeclaredZones].filter((zone) => ZONE_NAME.test(zone)),
  );
  const referenced = new Set(
    [...referencedZones].filter((zone) => ZONE_NAME.test(zone)),
  );
  const required = ['site_limit', ...[...referenced].sort()];
  const addedZones = required.filter((zone, index) =>
    required.indexOf(zone) === index
      && !declared.has(zone)
      && !externallyDeclared.has(zone),
  );

  if (addedZones.length === 0) {
    return {
      content: current,
      declaredCount: declared.size,
      referencedCount: referenced.size,
      addedZones,
    };
  }

  const additions = addedZones.map((zone) => {
    const size = zone === 'site_limit' ? '10m' : '1m';
    return `limit_req_zone $binary_remote_addr zone=${zone}:${size} rate=30r/s;`;
  });
  const base = current.trim().length > 0 ? current : `${NGINX_ZONES_HEADER}\n`;
  const separator = base.endsWith('\n') ? '' : '\n';
  const content = `${base}${separator}\n# Compatibility zones preserved during migration.\n${additions.join('\n')}\n`;

  return {
    content,
    declaredCount: declared.size + addedZones.length,
    referencedCount: referenced.size,
    addedZones,
  };
}
