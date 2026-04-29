import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto } from './users.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll() {
    const users = await this.usersService.findAll();
    return { success: true, data: users };
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async create(@Body() dto: CreateUserDto) {
    const user = await this.usersService.create(dto);
    return { success: true, data: user };
  }

  @Put(':id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    // /users/:id — требует подтверждения текущим паролем (см. UpdateUserDto).
    await this.usersService.verifyPassword(id, dto.currentPassword);
    const { currentPassword: _unused, ...payload } = dto;
    void _unused;
    const user = await this.usersService.update(id, payload);
    return { success: true, data: user };
  }

  @Delete(':id')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    await this.usersService.delete(id);
    return { success: true, data: null };
  }
}
