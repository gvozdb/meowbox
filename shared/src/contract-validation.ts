export type ContractRecord = Record<string, unknown>;

export function isContractRecord(value: unknown): value is ContractRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireExactKeys(
  value: ContractRecord,
  required: readonly string[],
  optional: readonly string[] = [],
  label = 'value',
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

export function requireString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 1024;
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`);
  return value;
}

export function requireEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

export function requireIsoDate(value: unknown, label: string): string {
  const raw = requireString(value, label, { max: 64 });
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== raw) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

export function requireUniqueStrings(
  value: unknown,
  label: string,
  options: { maxItems?: number; maxLength?: number; pattern?: RegExp } = {},
): string[] {
  const maxItems = options.maxItems ?? 128;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} is invalid`);
  }
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`, {
    max: options.maxLength ?? 256,
    pattern: options.pattern,
  }));
  if (new Set(result).size !== result.length) throw new Error(`${label} has duplicates`);
  return result;
}

export function requireHttpsOrigin(value: unknown, label: string): string {
  const raw = requireString(value, label, { max: 2048, pattern: /^[\x21-\x7e]+$/ });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== raw
  ) {
    throw new Error(`${label} is not a canonical HTTPS origin`);
  }
  return raw;
}

