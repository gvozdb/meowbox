import { BadRequestException, Controller, Get, Post, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { ProcessesService } from './processes.service';

// PM2-имя процесса попадает в argv `pm2 stop|restart|reload|logs <name>`.
// Допускаем только буквы/цифры/`._-` и ограничиваем длину — иначе можно
// прокинуть `..` (DoS на агенте) или подсунуть имя начинающееся с `-`,
// которое pm2 примет за флаг.
const PM2_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertPm2Name(name: string): string {
  if (typeof name !== 'string' || !PM2_NAME_RE.test(name)) {
    throw new BadRequestException('Invalid process name');
  }
  return name;
}

@Controller('processes')
@Roles('ADMIN')
export class ProcessesController {
  constructor(private readonly processesService: ProcessesService) {}

  @Get()
  async list() {
    const data = await this.processesService.list();
    return { success: true, data };
  }

  @Get(':name')
  async getProcess(@Param('name') name: string) {
    const data = await this.processesService.getProcess(assertPm2Name(name));
    return { success: true, data };
  }

  @Post(':name/stop')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async stop(@Param('name') name: string) {
    await this.processesService.stop(assertPm2Name(name));
    return { success: true };
  }

  @Post(':name/restart')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async restart(@Param('name') name: string) {
    await this.processesService.restart(assertPm2Name(name));
    return { success: true };
  }

  @Post(':name/reload')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async reload(@Param('name') name: string) {
    await this.processesService.reload(assertPm2Name(name));
    return { success: true };
  }

  @Get(':name/logs')
  async getLogs(@Param('name') name: string, @Query('lines') lines?: string) {
    // lines: clamp в [1, 10000] чтобы не дёрнуть огромный вывод.
    const parsed = lines ? parseInt(lines, 10) : 100;
    const safeLines = Number.isFinite(parsed) ? Math.min(10000, Math.max(1, parsed)) : 100;
    const data = await this.processesService.getLogs(assertPm2Name(name), safeLines);
    return { success: true, data };
  }
}
