import { CommandExecutor } from '../command-executor';

// Путь к ufw отличается на разных дистрибутивах (Debian/Ubuntu — /usr/sbin/ufw,
// иногда /usr/bin/ufw). Дефолт стандартный, переопределяется через UFW_BIN.
const UFW_BIN = process.env.UFW_BIN || '/usr/sbin/ufw';

interface FirewallRule {
  action: 'ALLOW' | 'DENY';
  protocol: 'TCP' | 'UDP' | 'BOTH';
  port?: string | null;
  sourceIp?: string | null;
  comment?: string | null;
}

/**
 * Строгая валидация источника (IPv4/IPv6 + опциональный CIDR). Хоть execFile
 * не проходит через shell, у `ufw` свой парсер аргументов: строка `--` или
 * `any/any` могут изменить семантику правила. Лучше отсечь на входе.
 */
const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|[01]?\d?\d)(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const IPV6_CIDR = /^([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{0,4}(::)?([0-9a-fA-F]{0,4}:?){0,6}(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;
const IPV6_SIMPLE = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;

function isValidSource(ip: string): boolean {
  const s = ip.trim();
  if (!s) return false;
  if (s.toLowerCase() === 'any') return true;
  if (IPV4_CIDR.test(s)) return true;
  // IPv6: комбинируем два теста — регулярки для IPv6 полны уязвимостей;
  // пусть финальное решение примет Node's net.isIP через require.
  if (IPV6_CIDR.test(s) || IPV6_SIMPLE.test(s)) {
    try {
      const net = require('net') as typeof import('net');
      const pure = s.split('/')[0];
      return net.isIP(pure) === 6;
    } catch {
      return false;
    }
  }
  return false;
}

/** Комментарий не должен выходить за рамки ASCII-печатного диапазона. */
function sanitizeComment(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '').slice(0, 128);
}

interface FirewallResult {
  success: boolean;
  error?: string;
}

export class FirewallManager {
  private executor: CommandExecutor;

  constructor() {
    this.executor = new CommandExecutor();
  }

  async addRule(rule: FirewallRule): Promise<FirewallResult> {
    try {
      const args = this.buildUfwArgs('add', rule);
      const result = await this.executor.execute(UFW_BIN, args);

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async removeRule(rule: FirewallRule): Promise<FirewallResult> {
    try {
      const args = this.buildUfwArgs('delete', rule);
      const result = await this.executor.execute(UFW_BIN, args);

      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async status(): Promise<{
    enabled: boolean;
    rules: Array<{ to: string; action: string; from: string }>;
  }> {
    const result = await this.executor.execute(UFW_BIN, ['status']);
    const output = result.stdout;
    const enabled = output.includes('Status: active');

    const lines = output.split('\n');
    const rulesStart = lines.findIndex((l) => l.startsWith('--'));
    const rules: Array<{ to: string; action: string; from: string }> = [];

    if (rulesStart >= 0) {
      for (const line of lines.slice(rulesStart + 1)) {
        if (!line.trim()) continue;
        // Format: "To                         Action      From"
        // Each column is whitespace-padded; Action is ALLOW/DENY/REJECT + optional IN/OUT
        const match = line.match(
          /^(.+?)\s{2,}(ALLOW|DENY|REJECT)(?:\s+IN)?\s{2,}(.+?)\s*$/,
        );
        if (match) {
          rules.push({
            to: match[1].trim(),
            action: match[2].trim(),
            from: match[3].trim(),
          });
        }
      }
    }

    return { enabled, rules };
  }

  private buildUfwArgs(action: 'add' | 'delete', rule: FirewallRule): string[] {
    const args: string[] = [];

    if (action === 'delete') {
      args.push('delete');
    }

    if (rule.action !== 'ALLOW' && rule.action !== 'DENY') {
      throw new Error(`Invalid firewall action: ${rule.action}`);
    }
    args.push(rule.action === 'ALLOW' ? 'allow' : 'deny');

    if (rule.sourceIp) {
      if (!isValidSource(rule.sourceIp)) {
        throw new Error(`Invalid source IP/CIDR: ${rule.sourceIp}`);
      }
      args.push('from', rule.sourceIp);
    }

    if (rule.port) {
      // Порт: число 1..65535 или диапазон 80:8080. Защищаемся от `any/any` и флагов.
      if (!/^(\d{1,5})(:\d{1,5})?$/.test(rule.port)) {
        throw new Error(`Invalid firewall port: ${rule.port}`);
      }
      args.push('to', 'any', 'port', rule.port);
    }

    if (rule.protocol && rule.protocol !== 'BOTH' && rule.port) {
      if (rule.protocol !== 'TCP' && rule.protocol !== 'UDP') {
        throw new Error(`Invalid firewall protocol: ${rule.protocol}`);
      }
      args.push('proto', rule.protocol.toLowerCase());
    }

    if (rule.comment && action === 'add') {
      args.push('comment', sanitizeComment(rule.comment));
    }

    return args;
  }
}
