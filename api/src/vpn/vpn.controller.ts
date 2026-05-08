import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { VpnService } from './vpn.service';
import {
  AddUserToServiceDto,
  CreateServiceDto,
  CreateUserDto,
  RotateSniDto,
  UpdateUserDto,
  ValidateSniDto,
} from './vpn.dto';
import { VpnRegistry } from './vpn.registry';
import { VpnProtocol } from '@meowbox/shared';

function parseProtocol(raw: string): VpnProtocol {
  if (raw === VpnProtocol.VLESS_REALITY || raw === VpnProtocol.AMNEZIA_WG) {
    return raw as VpnProtocol;
  }
  throw new BadRequestException(`Unknown protocol: ${raw}`);
}

@Controller('vpn')
export class VpnController {
  constructor(
    private readonly service: VpnService,
    private readonly registry: VpnRegistry,
  ) {}

  // ---- Meta ----

  @Get('protocols')
  @Roles('ADMIN')
  protocols() {
    return { success: true, data: this.registry.list() };
  }

  // ---- Runtime install/uninstall ----

  @Get('install-status')
  @Roles('ADMIN')
  async installStatus() {
    const data = await this.service.getInstallStatus();
    return { success: true, data };
  }

  @Post('install/:protocol')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 60000, limit: 3 } })
  async installRuntime(@Param('protocol') protocol: string) {
    const proto = parseProtocol(protocol);
    const data = await this.service.installRuntime(proto);
    return { success: true, data };
  }

  @Delete('install/:protocol')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 60000, limit: 3 } })
  async uninstallRuntime(@Param('protocol') protocol: string) {
    const proto = parseProtocol(protocol);
    await this.service.uninstallRuntime(proto);
    return { success: true };
  }

  // ---- Services ----

  @Get('services')
  @Roles('ADMIN')
  async listServices() {
    const data = await this.service.listServices();
    return { success: true, data };
  }

  @Get('services/:id')
  @Roles('ADMIN')
  async getService(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.service.getService(id);
    return { success: true, data };
  }

  @Post('services')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 10 } })
  async createService(@Body() dto: CreateServiceDto) {
    const data = await this.service.createService(dto);
    return { success: true, data };
  }

  @Delete('services/:id')
  @Roles('ADMIN')
  async deleteService(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteService(id);
    return { success: true };
  }

  @Post('services/:id/start')
  @Roles('ADMIN')
  async startService(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.startService(id);
    return { success: true };
  }

  @Post('services/:id/stop')
  @Roles('ADMIN')
  async stopService(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.stopService(id);
    return { success: true };
  }

  @Post('services/:id/rotate-sni')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 5 } })
  async rotateSni(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RotateSniDto,
  ) {
    await this.service.rotateSni(id, dto.newSni);
    return { success: true };
  }

  @Post('services/:id/rotate-keys')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 5 } })
  async rotateKeys(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.rotateKeys(id);
    return { success: true };
  }

  @Post('validate-sni')
  @Roles('ADMIN')
  @Throttle({ short: { ttl: 1000, limit: 5 } })
  async validateSni(@Body() dto: ValidateSniDto) {
    const data = await this.service.validateSni(dto.sniMask);
    return { success: true, data };
  }

  @Post('sni-health-check')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 5 } })
  async sniHealthCheck() {
    const data = await this.service.runSniHealthCheck();
    return { success: true, data };
  }

  // ---- Users ----

  @Get('users')
  @Roles('ADMIN')
  async listUsers() {
    const data = await this.service.listUsers();
    return { success: true, data };
  }

  @Get('users/:id')
  @Roles('ADMIN')
  async getUser(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.service.getUser(id);
    return { success: true, data };
  }

  @Post('users')
  @Roles('ADMIN')
  @Throttle({ medium: { ttl: 10000, limit: 20 } })
  async createUser(@Body() dto: CreateUserDto) {
    const data = await this.service.createUser(dto);
    return { success: true, data };
  }

  @Patch('users/:id')
  @Roles('ADMIN')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    const data = await this.service.updateUser(id, dto);
    return { success: true, data };
  }

  @Delete('users/:id')
  @Roles('ADMIN')
  async deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.deleteUser(id);
    return { success: true };
  }

  @Post('users/:id/regenerate-sub-token')
  @Roles('ADMIN')
  async regenerateSubToken(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.service.regenerateSubToken(id);
    return { success: true, data };
  }

  @Post('users/:id/services')
  @Roles('ADMIN')
  async addUserToService(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddUserToServiceDto,
  ) {
    const data = await this.service.addUserToService(id, dto.serviceId);
    return { success: true, data };
  }

  @Delete('users/:userId/services/:serviceId')
  @Roles('ADMIN')
  async removeUserFromService(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    await this.service.removeUserFromService(userId, serviceId);
    return { success: true };
  }

  @Get('users/:userId/services/:serviceId/creds')
  @Roles('ADMIN')
  async getUserCreds(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    const data = await this.service.getUserCredsView(userId, serviceId);
    return { success: true, data };
  }

  // ---- Subscription (public, no JWT — auth by random token) ----

  @Public()
  @Get('sub/:token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Throttle({ short: { ttl: 60000, limit: 30 } })
  async subscription(@Param('token') token: string, @Res() res: Response) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new BadRequestException('invalid token');
    }
    const data = await this.service.buildSubscription(token);
    res.send(data);
  }

  @Post('sub/health-check-noop')
  @Public()
  @HttpCode(204)
  // dummy для health-check без логина (используется в smoke test'ах)
  noop() {
    return;
  }
}
