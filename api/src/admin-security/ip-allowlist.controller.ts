/**
 * REST для IP allowlist:
 *   GET    /api/admin/ip-allowlist           — текущий конфиг + клиентский IP
 *   PUT    /api/admin/ip-allowlist           — заменить целиком (с защитой от самобана)
 *   POST   /api/admin/ip-allowlist/entries   — добавить запись
 *   DELETE /api/admin/ip-allowlist/entries/:cidr — удалить запись
 *   POST   /api/admin/ip-allowlist/reload    — внутренний bypass для CLI/Make
 *
 * Защита от самобана: если operator пытается включить allowlist (или удалить
 * себя из enabled-списка), и его текущий IP не входит в новый список —
 * 400 BadRequest «ты сам себя забанишь, добавь свой IP X.X.X.X».
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req, BadRequestException } from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

import { IpAllowlistEntry, IpAllowlistConfig, IpAllowlistService } from './ip-allowlist.service';

interface ReqLike {
  ip?: string;
  socket?: { remoteAddress?: string };
}

@Controller('admin/ip-allowlist')
@Roles(UserRole.ADMIN)
export class IpAllowlistController {
  constructor(private readonly service: IpAllowlistService) {}

  @Get()
  async getConfig(@Req() req: ReqLike) {
    const data = this.service.getConfig();
    const clientIp = this.clientIp(req);
    return {
      success: true,
      data: {
        ...data,
        clientIp,
        // Подскажем фронту, в списке ли сейчас оператор: если выключаем
        // allowlist — лоч-проверка не нужна, но UI может предупредить.
        clientIpAllowed: this.service.isAllowed(clientIp),
      },
    };
  }

  @Put()
  async putConfig(@Body() body: Partial<IpAllowlistConfig>, @Req() req: ReqLike) {
    const sanitized = this.service.validate(body);
    if (sanitized.enabled) {
      this.assertOperatorWontBan(sanitized, this.clientIp(req));
    }
    const data = await this.service.save(sanitized);
    return { success: true, data };
  }

  @Post('entries')
  async addEntry(@Body() body: Partial<IpAllowlistEntry> & { useClientIp?: boolean }, @Req() req: ReqLike) {
    const cur = this.service.getConfig();
    let cidr = typeof body.cidr === 'string' ? body.cidr.trim() : '';
    if (body.useClientIp || cidr === '') {
      cidr = this.clientIp(req);
      if (!cidr) {
        throw new BadRequestException('Не удалось определить ваш текущий IP');
      }
    }
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const next: IpAllowlistConfig = {
      enabled: cur.enabled,
      entries: [...cur.entries, { cidr, label: label || (body.useClientIp ? 'мой текущий IP' : '') }],
    };
    const sanitized = this.service.validate(next);
    if (sanitized.enabled) {
      this.assertOperatorWontBan(sanitized, this.clientIp(req));
    }
    const data = await this.service.save(sanitized);
    return { success: true, data };
  }

  @Delete('entries/:cidr')
  async removeEntry(@Param('cidr') cidrParam: string, @Req() req: ReqLike) {
    const target = this.service.normalizeCidr(decodeURIComponent(cidrParam || '').trim());
    const cur = this.service.getConfig();
    const next: IpAllowlistConfig = {
      enabled: cur.enabled,
      entries: cur.entries.filter((e) => e.cidr !== target),
    };
    const sanitized = this.service.validate(next);
    if (sanitized.enabled) {
      this.assertOperatorWontBan(sanitized, this.clientIp(req));
    }
    const data = await this.service.save(sanitized);
    return { success: true, data };
  }

  /**
   * Reload без перезаписи (используется make-командой `make ip-allow`,
   * которая правит запись напрямую в БД — после этого надо инвалидировать
   * in-memory BlockList, иначе изменения подхватятся только после рестарта).
   * Доступ — обычный ADMIN-cookie/JWT, как остальные эндпоинты.
   */
  @Post('reload')
  async reload() {
    const data = await this.service.reload();
    return { success: true, data };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private clientIp(req: ReqLike): string {
    return req.ip || req.socket?.remoteAddress || '';
  }

  /**
   * Если allowlist включён и текущий IP оператора в него НЕ попадает —
   * блокируем сохранение. Иначе следующий же запрос к API получит 403,
   * и оператор останется заблокированным со своего рабочего места.
   */
  private assertOperatorWontBan(cfg: IpAllowlistConfig, clientIp: string): void {
    if (!cfg.enabled) return;
    if (!clientIp) {
      throw new BadRequestException(
        'Не удалось определить ваш текущий IP — нельзя безопасно включить allowlist',
      );
    }
    if (this.service.simulateAllowed(cfg, clientIp)) return;
    throw new BadRequestException(
      `Ваш текущий IP ${clientIp} не входит в allowlist — вы сами себя забаните. ` +
        `Добавьте его в список или используйте кнопку «Добавить мой IP».`,
    );
  }
}
