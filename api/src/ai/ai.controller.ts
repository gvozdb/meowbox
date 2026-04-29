import { Controller, Get, Delete, Patch, Param, Body, ParseUUIDPipe } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { AiService } from './ai.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

interface JwtUser {
  id: string;
  role: string;
}

export class RenameAiSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;
}

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('sessions')
  async listSessions(@CurrentUser() user?: JwtUser) {
    const sessions = await this.aiService.listSessions(user!.id);
    return { success: true, data: sessions };
  }

  @Get('sessions/:id')
  async getSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    const session = await this.aiService.getSession(id, user!.id);
    return { success: true, data: session };
  }

  @Delete('sessions/:id')
  async deleteSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.aiService.deleteSession(id, user!.id);
    return { success: true };
  }

  @Patch('sessions/:id')
  async renameSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RenameAiSessionDto,
    @CurrentUser() user?: JwtUser,
  ) {
    await this.aiService.renameSession(id, user!.id, body.title);
    return { success: true };
  }
}
