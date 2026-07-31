import { SiteType } from './enums';

const SITE_TYPES = new Set<string>(Object.values(SiteType));

/** Deterministic compatibility mapping for old hostpanel plans. */
export function hostpanelPresetFromSource(
  sourceCms: unknown,
  sourceCmsVersion: unknown,
): SiteType {
  if (sourceCms !== 'modx') return SiteType.CUSTOM;
  return /^3(?:\.|$)/.test(String(sourceCmsVersion || '').trim())
    ? SiteType.MODX_3
    : SiteType.MODX_REVO;
}

/**
 * New plans carry an explicit supported preset. Missing values are accepted
 * only as a compatibility input and immediately mapped.
 */
export function normalizeHostpanelPreset(
  preset: unknown,
  sourceCms: unknown,
  sourceCmsVersion: unknown,
): SiteType {
  if (preset == null || preset === '') {
    return hostpanelPresetFromSource(sourceCms, sourceCmsVersion);
  }
  if (!SITE_TYPES.has(String(preset))) {
    throw new Error(`Unsupported hostpanel application preset "${String(preset)}"`);
  }
  return preset as SiteType;
}

export function isModxPreset(preset: unknown): boolean {
  return preset === SiteType.MODX_REVO || preset === SiteType.MODX_3;
}
