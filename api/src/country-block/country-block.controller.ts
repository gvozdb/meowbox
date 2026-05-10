import {
  Controller, Get, Post, Patch, Delete, Body, Param, BadRequestException,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
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
  async sync() {
    const data = await this.service.sync();
    return { success: data.success, data };
  }

  @Post('refresh-db')
  async refreshDb(@Body() body: RefreshDbDto) {
    if (body.countries && !Array.isArray(body.countries)) {
      throw new BadRequestException('countries должен быть массивом ISO-кодов');
    }
    const data = await this.service.refreshDb(body.countries);
    return { success: data.success, data };
  }

  @Get('status')
  async status() {
    const data = await this.service.getStatus();
    return { success: data.success, data };
  }
}
