import { Controller, Get, Param } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RemoteContextService } from './remote-context.service';

@Controller('servers')
@Roles('ADMIN', 'MANAGER')
export class RemoteContextController {
  constructor(private readonly contexts: RemoteContextService) {}

  @Get(':id/context')
  async getContext(@Param('id') id: string) {
    return { success: true, data: await this.contexts.getBrowserContext(id) };
  }
}

