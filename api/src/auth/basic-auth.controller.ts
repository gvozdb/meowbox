import { Controller, Get, Post, Body, BadRequestException } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { BasicAuthService } from './basic-auth.service';
import { Roles } from '../common/decorators/roles.decorator';

class BasicAuthDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_.-]+$/, { message: 'Username: letters, digits, _.-' })
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}

@Controller('auth/basic-auth')
@Roles('ADMIN')
export class BasicAuthController {
  constructor(private readonly service: BasicAuthService) {}

  @Get()
  async getConfig() {
    const data = await this.service.getConfig();
    return { success: true, data };
  }

  @Post()
  async update(@Body() dto: BasicAuthDto) {
    if (dto.enabled) {
      if (!dto.username || !dto.password) {
        throw new BadRequestException('username and password are required to enable Basic Auth');
      }
      await this.service.enable(dto.username, dto.password);
    } else {
      await this.service.disable();
    }
    const data = await this.service.getConfig();
    return { success: true, data };
  }
}
