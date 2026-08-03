import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DatabasesService } from './databases.service';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('databases')
export class DatabaseCatalogController {
  constructor(private readonly databasesService: DatabasesService) {}

  @Get()
  async findAll(
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const result = await this.databasesService.findAllAcrossSites({
      userId: user!.id,
      role: user!.role,
      type,
      search,
      page: page ? Number.parseInt(page, 10) : undefined,
      perPage: perPage ? Number.parseInt(perPage, 10) : undefined,
    });

    return { success: true, data: result.databases, meta: result.meta };
  }
}
