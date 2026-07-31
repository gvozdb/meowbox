import { resolve } from 'node:path';

export interface HookArguments {
  readonly command?: string;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export function parseHookArguments(argv: readonly string[], withCommand = false): HookArguments {
  let index = 0;
  let command: string | undefined;
  if (withCommand) {
    command = argv[index];
    if (!command || command.startsWith('--')) throw new Error('hook command is required');
    index += 1;
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  while (index < argv.length) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || option.length <= 2) {
      throw new Error(`invalid hook argument near ${option || '<end>'}`);
    }
    const key = option.slice(2);
    if (values.has(key) || flags.has(key)) throw new Error(`duplicate hook option --${key}`);
    if (!value || value.startsWith('--')) {
      flags.add(key);
      index += 1;
      continue;
    }
    values.set(key, value);
    index += 2;
  }
  return { command, values, flags };
}

export function requiredHookOption(arguments_: HookArguments, key: string): string {
  const value = arguments_.values.get(key);
  if (!value) throw new Error(`--${key} is required`);
  if (value.includes('\0')) throw new Error(`--${key} contains NUL`);
  return value;
}

export function requiredAbsolutePath(arguments_: HookArguments, key: string): string {
  const value = requiredHookOption(arguments_, key);
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`--${key} must be an absolute normalized path`);
  return absolute;
}

export function requiredMode(arguments_: HookArguments): 'dry-run' | 'apply' {
  const mode = requiredHookOption(arguments_, 'mode');
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error('--mode must be dry-run or apply');
  return mode;
}

export function hasHookFlag(arguments_: HookArguments, key: string): boolean {
  return arguments_.flags.has(key);
}
