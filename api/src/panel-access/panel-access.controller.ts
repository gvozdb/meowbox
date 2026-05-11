import { Body, Controller, Delete, Get, Logger, Post, Put } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { PanelAccessService } from './panel-access.service';
import { IssueLeDto, SetDomainDto, UpdatePanelAccessDto } from './panel-access.dto';

/**
 * Управление доступом к панели:
 *   - привязка/отвязка domain
 *   - выпуск HTTPS-сертификата (LE на домен; self-signed на IP)
 *   - 301 редирект http → https
 *   - запрет доступа через IP:PORT (когда привязан домен и есть валидный cert)
 *
 * ВНИМАНИЕ: каждый PUT/POST/DELETE здесь приводит к `nginx -t` + reload через
 * агента. Если nginx-конфиг не валиден — агент откатит файл и вернёт error,
 * мы вернём BadRequest с текстом ошибки. Текущая работающая конфигурация в
 * этом случае НЕ сломается.
 */
@Controller('panel-access')
@Roles('ADMIN')
export class PanelAccessController {
  private readonly logger = new Logger('PanelAccessController');

  constructor(private readonly service: PanelAccessService) {}

  /** Полный снапшот: настройки + live-данные (cert на диске, DNS, IP). */
  @Get()
  async getStatus() {
    const data = await this.service.getStatus();
    const defaultEmail = await this.service.getDefaultEmail();
    return { success: true, data: { ...data, defaultEmail } };
  }

  // ── Domain ────────────────────────────────────────────────────────────────
  @Put('domain')
  async setDomain(@Body() body: SetDomainDto) {
    const domain = body.domain && body.domain.trim() ? body.domain.trim() : null;
    const data = await this.service.setDomain(domain);
    return { success: true, data };
  }

  // ── Behavior (redirect, deny-ip) ──────────────────────────────────────────
  @Put('behavior')
  async updateBehavior(@Body() body: UpdatePanelAccessDto) {
    const data = await this.service.updateBehavior(body.httpsRedirect, body.denyIpAccess);
    return { success: true, data };
  }

  // ── Cert: Let's Encrypt ────────────────────────────────────────────────────
  @Post('cert/le')
  async issueLe(@Body() body: IssueLeDto) {
    const data = await this.service.issueLeCert(body.email);
    return { success: true, data };
  }

  // ── Cert: self-signed (только без domain) ──────────────────────────────────
  @Post('cert/selfsigned')
  async issueSelfSigned() {
    const data = await this.service.issueSelfSignedCert();
    return { success: true, data };
  }

  // ── Cert: удалить ──────────────────────────────────────────────────────────
  @Delete('cert')
  async removeCert() {
    const data = await this.service.removeCert();
    return { success: true, data };
  }
}
