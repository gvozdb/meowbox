import {
  Controller, Get, Post, Patch, Delete, Body, Param, ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { StorageLocationsService } from './storage-locations.service';
import { CreateStorageLocationDto, UpdateStorageLocationDto } from './storage-locations.dto';

@Controller('storage-locations')
export class StorageLocationsController {
  constructor(private readonly service: StorageLocationsService) {}

  // Конфиги хранилищ содержат имена бакетов/endpoint'ов/usernameов и схему,
  // которыми обычным юзерам/вьюверам делиться не следует. Секреты уже
  // redacted в toView(), но и сама структура конфига — это утечка
  // инфраструктуры. Список доступен только ADMIN'ам.
  @Get()
  @Roles('ADMIN')
  async list() {
    const items = await this.service.list();
    return { success: true, data: items };
  }

  @Post()
  @Roles('ADMIN')
  async create(@Body() dto: CreateStorageLocationDto) {
    const res = await this.service.create(dto);
    return { success: true, data: res };
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStorageLocationDto,
  ) {
    const updated = await this.service.update(id, dto);
    return { success: true, data: updated };
  }

  @Delete(':id')
  @Roles('ADMIN')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
    return { success: true };
  }

  @Post(':id/test')
  @Roles('ADMIN')
  async test(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('siteName') siteName?: string,
  ) {
    // Для теста используем имя-placeholder, если не указано (в репе появится тест-сабдир)
    const name = siteName || '_connection-test_';
    const res = await this.service.test(id, name);
    // Заворачиваем в стандартный конверт {success, data}, иначе клиент получит undefined
    // после `response.data` в useApi — и словит «Cannot read properties of undefined».
    return { success: true, data: res };
  }
}
