export interface NginxZoneInput {
  readonly zoneName: string;
  readonly rps: number;
  readonly enabled?: boolean;
}

export const NGINX_ZONES_HEADER =
`# === Meowbox global rate-limit zones (управляется агентом) ===
# Файл регенерируется при создании/удалении сайта и при изменении rate-limit настроек.
# Не редактируй вручную — изменения будут затёрты.

# Legacy fallback zone (для конфигов сайтов, которые ещё не пере-генерены под per-zone).
limit_req_zone $binary_remote_addr zone=site_limit:10m rate=30r/s;
`;

function safeZoneName(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Pure renderer shared by normal agent updates and release staging. */
export function renderNginxZones(
  zones: ReadonlyArray<NginxZoneInput>,
  legacyZoneRefs: Iterable<string> = [],
): string {
  const lines: string[] = [NGINX_ZONES_HEADER.trimEnd(), ''];
  const seen = new Set<string>();

  for (const name of legacyZoneRefs) {
    const safe = safeZoneName(name);
    if (!safe || safe === 'site_limit' || seen.has(safe)) continue;
    seen.add(safe);
    lines.push(`limit_req_zone $binary_remote_addr zone=${safe}:1m rate=30r/s;`);
  }
  for (const zone of zones) {
    const safe = safeZoneName(zone.zoneName);
    if (!safe || safe === 'site_limit' || seen.has(safe)) continue;
    seen.add(safe);
    const rate = Number.isInteger(zone.rps) && zone.rps > 0 ? zone.rps : 30;
    lines.push(`limit_req_zone $binary_remote_addr zone=${safe}:1m rate=${rate}r/s;`);
  }
  return `${lines.join('\n')}\n`;
}
