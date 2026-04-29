import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AgentRelayService } from '../gateway/agent-relay.service';

export interface Pm2Process {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
}

@Injectable()
export class ProcessesService {
  constructor(private readonly agentRelay: AgentRelayService) {}

  async list(): Promise<Pm2Process[]> {
    const result = await this.agentRelay.emitToAgent<Pm2Process[]>('pm2:list', {});
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to list processes');
    }
    return result.data || [];
  }

  async getProcess(name: string) {
    const result = await this.agentRelay.emitToAgent<Pm2Process>('pm2:status', { name });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Process not found');
    }
    return result.data;
  }

  async stop(name: string) {
    const result = await this.agentRelay.emitToAgent('pm2:stop', { name });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to stop process');
    }
  }

  async restart(name: string) {
    const result = await this.agentRelay.emitToAgent('pm2:restart', { name });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to restart process');
    }
  }

  async reload(name: string) {
    const result = await this.agentRelay.emitToAgent('pm2:reload', { name });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to reload process');
    }
  }

  async getLogs(name: string, lines: number = 100) {
    const result = await this.agentRelay.emitToAgent<{ stdout: string; stderr: string }>('pm2:logs', { name, lines });
    if (!result.success) {
      throw new InternalServerErrorException(result.error || 'Failed to get logs');
    }
    return result.data;
  }
}
