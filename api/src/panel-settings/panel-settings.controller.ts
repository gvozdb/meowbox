import { Controller, Get, Put, Body, BadRequestException } from '@nestjs/common';
import { PanelSettingsService, VALID_PALETTES, isValidPalette } from './panel-settings.service';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('panel-settings')
@Roles('ADMIN')
export class PanelSettingsController {
  constructor(private readonly service: PanelSettingsService) {}

  // ── General (мониторинг/сессии/обновления) ─────────────────────────────
  @Get()
  async getGeneral() {
    const data = await this.service.get('general');
    return { success: true, data };
  }

  @Put()
  async setGeneral(@Body() body: Record<string, unknown>) {
    await this.service.set('general', body);
    const data = await this.service.get('general');
    return { success: true, data };
  }

  // ── Site defaults (пути + дефолты формы создания) ──────────────────────
  @Get('site-defaults')
  async getSiteDefaults() {
    const data = await this.service.getSiteDefaults();
    return { success: true, data };
  }

  @Put('site-defaults')
  async setSiteDefaults(@Body() body: Record<string, unknown>) {
    // Валидация ключевых полей — путь должен быть абсолютным, relativePath не должен начинаться со слэша / содержать ..
    const basePath = typeof body.sitesBasePath === 'string' ? body.sitesBasePath.trim() : '';
    const relPath = typeof body.siteFilesRelativePath === 'string' ? body.siteFilesRelativePath.trim() : 'www';

    if (!basePath.startsWith('/')) {
      throw new BadRequestException('sitesBasePath должен быть абсолютным путём (начинаться со /)');
    }
    if (basePath.includes('..') || basePath.endsWith('/')) {
      throw new BadRequestException('sitesBasePath содержит недопустимые символы или завершается слэшем');
    }
    if (!/^[a-zA-Z0-9_\-./]+$/.test(basePath)) {
      throw new BadRequestException('sitesBasePath содержит недопустимые символы');
    }
    if (relPath.startsWith('/') || relPath.includes('..') || !/^[a-zA-Z0-9_\-./]+$/.test(relPath)) {
      throw new BadRequestException('siteFilesRelativePath должен быть относительным и без ".."');
    }

    const sanitized = {
      sitesBasePath: basePath,
      siteFilesRelativePath: relPath || 'www',
      defaultPhpVersion: typeof body.defaultPhpVersion === 'string' ? body.defaultPhpVersion : '8.2',
      defaultDbType: typeof body.defaultDbType === 'string' ? body.defaultDbType : 'MARIADB',
      defaultAutoSsl: !!body.defaultAutoSsl,
      defaultHttpsRedirect: body.defaultHttpsRedirect !== false,
    };

    await this.service.set('site-defaults', sanitized);
    const data = await this.service.getSiteDefaults();
    return { success: true, data };
  }

  // ── Backup defaults (автобэкапы) ───────────────────────────────────────
  @Get('backup-defaults')
  async getBackupDefaults() {
    const data = await this.service.get('backup-defaults');
    return { success: true, data };
  }

  @Put('backup-defaults')
  async setBackupDefaults(@Body() body: Record<string, unknown>) {
    await this.service.set('backup-defaults', body);
    const data = await this.service.get('backup-defaults');
    return { success: true, data };
  }

  // ── Appearance (цветовая гамма панели — per-server) ────────────────────
  // Палитра хранится только на мастере: { palettes: { [serverId]: PaletteId } }.
  // Допустимые id — VALID_PALETTES (см. panel-settings.service). /servers и
  // /settings всегда пишут сюда напрямую (без прокси на slave) — фича работает
  // даже когда slave старой версии и сам endpoint /panel-settings/appearance
  // не поддерживает.
  @Get('appearance')
  async getAppearance() {
    const data = await this.service.getAppearance();
    return { success: true, data };
  }

  @Put('appearance')
  async setAppearance(@Body() body: Record<string, unknown>) {
    const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
    const paletteRaw = typeof body.palette === 'string' ? body.palette.trim() : '';
    if (!serverId) {
      throw new BadRequestException('serverId обязателен');
    }
    // Защита от мусорных id (длина и charset). Серверы — uuid-краткие либо 'main'.
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serverId)) {
      throw new BadRequestException('serverId содержит недопустимые символы');
    }
    if (!isValidPalette(paletteRaw)) {
      throw new BadRequestException(
        `palette должен быть одним из: ${VALID_PALETTES.join(', ')}`,
      );
    }
    const data = await this.service.setServerPalette(serverId, paletteRaw);
    return { success: true, data };
  }
}
