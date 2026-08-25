import {
  Controller, Get, Post, Patch, Delete, Body, Param, BadRequestException,
  Headers, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CountryBlockService } from './country-block.service';
import {
  CreateCountryBlockDto, UpdateCountryBlockDto, UpdateCountryBlockSettingsDto, RefreshDbDto,
} from './country-block.dto';

@Controller('country-block')
@Roles('ADMIN')
export class CountryBlockController {
  constructor(private readonly service: CountryBlockService) {}

  // ── Settings ────────────────────────────────────────────────────────────
  @Get('settings')
  async getSettings() {
    const data = await this.service.getSettings();
    return { success: true, data };
  }

  @Patch('settings')
  async updateSettings(@Body() body: UpdateCountryBlockSettingsDto) {
    const data = await this.service.updateSettings(body);
    return { success: true, data };
  }

  // ── Rules CRUD ──────────────────────────────────────────────────────────
  @Get('rules')
  async listRules() {
    const data = await this.service.listRules();
    return { success: true, data };
  }

  @Post('rules')
  async createRule(@Body() body: CreateCountryBlockDto) {
    const data = await this.service.createRule(body);
    return { success: true, data };
  }

  @Patch('rules/:id')
  async updateRule(@Param('id') id: string, @Body() body: UpdateCountryBlockDto) {
    const data = await this.service.updateRule(id, body);
    return { success: true, data };
  }

  @Delete('rules/:id')
  async deleteRule(@Param('id') id: string) {
    await this.service.removeRule(id);
    return { success: true };
  }

  // ── Sync / Refresh / Status ─────────────────────────────────────────────
  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sync(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.service.enqueueSync({ userId, role }, idempotencyKey);
    return { success: true, data };
  }

  @Post('refresh-db')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async refreshDb(
    @Body() body: RefreshDbDto,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (body.countries && !Array.isArray(body.countries)) {
      throw new BadRequestException('countries должен быть массивом ISO-кодов');
    }
    const data = await this.service.enqueueRefreshDb(
      body.countries,
      { userId, role },
      idempotencyKey,
    );
    return { success: true, data };
  }

  @Get('status')
  async status() {
    const data = await this.service.getStatus();
    return { success: data.success, data };
  }
}
