import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FirewallService } from './firewall.service';
import { CreateFirewallRuleDto, UpdateFirewallRuleDto } from './firewall.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FirewallOperationsService } from './firewall-operations.service';

@Controller('firewall')
@Roles('ADMIN')
export class FirewallController {
  constructor(
    private readonly firewallService: FirewallService,
    private readonly operations: FirewallOperationsService,
  ) {}

  @Get()
  async findAll() {
    const rules = await this.firewallService.findAll();
    return { success: true, data: rules };
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async create(@Body() dto: CreateFirewallRuleDto) {
    const rule = await this.firewallService.create(dto);
    return { success: true, data: rule };
  }

  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFirewallRuleDto,
  ) {
    const rule = await this.firewallService.update(id, dto);
    return { success: true, data: rule };
  }

  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    await this.firewallService.delete(id);
    return { success: true };
  }

  @Get('status')
  async getStatus() {
    const status = await this.firewallService.getUfwStatus();
    return { success: true, data: status };
  }

  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  // Полный пересбор ufw: дороговато, не чаще 5/мин чтобы кнопку не зажевали.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async syncRules(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.operations.enqueueSync({ userId, role }, idempotencyKey);
    return { success: true, data };
  }

  @Get('presets')
  async getPresets() {
    const presets = this.firewallService.getPresets();
    return { success: true, data: presets };
  }

  @Post('presets/:name/apply')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async applyPreset(
    @Param('name') name: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.operations.enqueuePreset(name, { userId, role }, idempotencyKey);
    return { success: true, data };
  }
}
