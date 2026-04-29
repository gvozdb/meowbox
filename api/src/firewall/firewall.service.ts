import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { FirewallRuleAction, FirewallProtocol } from '../common/enums';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import { CreateFirewallRuleDto, UpdateFirewallRuleDto } from './firewall.dto';

@Injectable()
export class FirewallService {
  private readonly logger = new Logger('FirewallService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async findAll() {
    return this.prisma.firewallRule.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateFirewallRuleDto) {
    const rule = await this.prisma.firewallRule.create({
      data: {
        action: dto.action as FirewallRuleAction,
        protocol: dto.protocol as FirewallProtocol,
        port: dto.port || null,
        sourceIp: dto.sourceIp || null,
        comment: dto.comment || null,
      },
    });

    // Agent: apply UFW rule (best-effort — rule is persisted regardless)
    if (this.agentRelay.isAgentConnected()) {
      try {
        const result = await this.agentRelay.emitToAgent('firewall:add-rule', {
          action: dto.action,
          protocol: dto.protocol,
          port: dto.port || null,
          sourceIp: dto.sourceIp || null,
          comment: dto.comment || null,
        });

        if (!result.success) {
          this.logger.warn(`UFW rule apply failed: ${result.error}`);
        } else {
          this.logger.log(`Firewall rule added: ${dto.action} ${dto.port || 'any'}`);
        }
      } catch (err) {
        this.logger.warn(`UFW rule apply error: ${(err as Error).message}`);
      }
    } else {
      this.logger.warn('Agent not connected — rule saved to DB, will be applied when agent connects');
    }

    return rule;
  }

  async update(id: string, dto: UpdateFirewallRuleDto) {
    const existing = await this.findByIdOrFail(id);

    // Remove old UFW rule, add new one
    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('firewall:remove-rule', {
          action: existing.action,
          protocol: existing.protocol,
          port: existing.port,
          sourceIp: existing.sourceIp,
        });
      } catch {
        // Ignore removal errors
      }
    }

    const updated = await this.prisma.firewallRule.update({
      where: { id },
      data: {
        ...(dto.action !== undefined && { action: dto.action as FirewallRuleAction }),
        ...(dto.protocol !== undefined && { protocol: dto.protocol as FirewallProtocol }),
        ...(dto.port !== undefined && { port: dto.port || null }),
        ...(dto.sourceIp !== undefined && { sourceIp: dto.sourceIp || null }),
        ...(dto.comment !== undefined && { comment: dto.comment || null }),
      },
    });

    // Add new rule
    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('firewall:add-rule', {
          action: updated.action,
          protocol: updated.protocol,
          port: updated.port,
          sourceIp: updated.sourceIp,
          comment: updated.comment,
        });
      } catch (err) {
        this.logger.error(`Failed to apply updated rule: ${(err as Error).message}`);
      }
    }

    return updated;
  }

  async delete(id: string) {
    const rule = await this.findByIdOrFail(id);

    // Agent: remove UFW rule
    if (this.agentRelay.isAgentConnected()) {
      try {
        await this.agentRelay.emitToAgent('firewall:remove-rule', {
          action: rule.action,
          protocol: rule.protocol,
          port: rule.port,
          sourceIp: rule.sourceIp,
        });
        this.logger.log(`Firewall rule removed: ${rule.action} ${rule.port || 'any'}`);
      } catch (err) {
        this.logger.error(`Failed to remove UFW rule: ${(err as Error).message}`);
      }
    }

    await this.prisma.firewallRule.delete({ where: { id } });
  }

  // ===========================================================================
  // UFW Status & Sync
  // ===========================================================================

  async getUfwStatus(): Promise<{
    enabled: boolean;
    rules: Array<{ to: string; action: string; from: string }>;
  }> {
    if (!this.agentRelay.isAgentConnected()) {
      return { enabled: false, rules: [] };
    }

    try {
      const result = await this.agentRelay.emitToAgent<{
        enabled: boolean;
        rules: Array<{ to: string; action: string; from: string }>;
      }>('firewall:status', {});

      if (result.success && result.data) {
        return result.data;
      }
    } catch (err) {
      this.logger.error(`Failed to get UFW status: ${(err as Error).message}`);
    }

    return { enabled: false, rules: [] };
  }

  /**
   * Re-apply all DB rules to UFW (e.g. after agent reconnect).
   */
  async syncRulesToUfw(): Promise<void> {
    if (!this.agentRelay.isAgentConnected()) {
      throw new InternalServerErrorException('Agent not connected');
    }

    const rules = await this.prisma.firewallRule.findMany();
    let applied = 0;

    for (const rule of rules) {
      try {
        const result = await this.agentRelay.emitToAgent('firewall:add-rule', {
          action: rule.action,
          protocol: rule.protocol,
          port: rule.port,
          sourceIp: rule.sourceIp,
          comment: rule.comment,
        });

        if (result.success) applied++;
        else this.logger.warn(`Sync rule failed (${rule.port}): ${result.error}`);
      } catch (err) {
        this.logger.warn(`Sync rule error (${rule.port}): ${(err as Error).message}`);
      }
    }

    this.logger.log(`Firewall sync: ${applied}/${rules.length} rules applied`);
  }

  // ===========================================================================
  // Presets
  // ===========================================================================

  getPresets() {
    return [
      {
        name: 'web-server',
        label: 'Web Server (HTTP/HTTPS)',
        rules: [
          { action: 'ALLOW', protocol: 'TCP', port: '80', comment: 'HTTP' },
          { action: 'ALLOW', protocol: 'TCP', port: '443', comment: 'HTTPS' },
        ],
      },
      {
        name: 'ssh',
        label: 'SSH',
        rules: [
          { action: 'ALLOW', protocol: 'TCP', port: '22', comment: 'SSH' },
        ],
      },
      {
        name: 'database',
        label: 'Database (MySQL/PostgreSQL)',
        rules: [
          { action: 'ALLOW', protocol: 'TCP', port: '3306', comment: 'MySQL/MariaDB' },
          { action: 'ALLOW', protocol: 'TCP', port: '5432', comment: 'PostgreSQL' },
        ],
      },
      {
        name: 'mail',
        label: 'Mail Server',
        rules: [
          { action: 'ALLOW', protocol: 'TCP', port: '25', comment: 'SMTP' },
          { action: 'ALLOW', protocol: 'TCP', port: '465', comment: 'SMTPS' },
          { action: 'ALLOW', protocol: 'TCP', port: '587', comment: 'Submission' },
          { action: 'ALLOW', protocol: 'TCP', port: '993', comment: 'IMAPS' },
        ],
      },
      {
        name: 'meowbox',
        label: 'Meowbox Panel',
        rules: [
          // Берём актуальный порт панели из env (PANEL_PORT) — иначе после
          // переустановки на нестандартный порт preset будет открывать чужой.
          {
            action: 'ALLOW',
            protocol: 'TCP',
            port: process.env.PANEL_PORT || '11862',
            comment: 'Meowbox Panel',
          },
        ],
      },
    ];
  }

  async applyPreset(presetName: string) {
    const presets = this.getPresets();
    const preset = presets.find((p) => p.name === presetName);
    if (!preset) {
      throw new NotFoundException(`Preset "${presetName}" not found`);
    }

    const created = [];
    for (const rule of preset.rules) {
      try {
        const result = await this.create({
          action: rule.action,
          protocol: rule.protocol,
          port: rule.port,
          comment: rule.comment,
        } as CreateFirewallRuleDto);
        created.push(result);
      } catch (err) {
        this.logger.warn(`Preset rule failed: ${(err as Error).message}`);
      }
    }

    return created;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private async findByIdOrFail(id: string) {
    const rule = await this.prisma.firewallRule.findUnique({
      where: { id },
    });

    if (!rule) throw new NotFoundException('Firewall rule not found');
    return rule;
  }
}
