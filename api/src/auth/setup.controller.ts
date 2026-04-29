import { Controller, Post, Get, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../common/prisma.service';
import { UsersService } from '../users/users.service';
import { SetupDto } from './setup.dto';

@Controller('setup')
export class SetupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Get('status')
  async getSetupStatus() {
    const adminExists = await this.prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });

    return {
      success: true,
      data: { needsSetup: !adminExists },
    };
  }

  @Public()
  @Post('init')
  @Throttle({ short: { ttl: 60000, limit: 3 } })
  async initializeAdmin(@Body() dto: SetupDto) {
    // Атомарная проверка-и-создание: два параллельных POST /setup/init
    // на свежей установке могли пройти проверку одновременно и создать
    // двух ADMIN. Сериализуем через $transaction.
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const adminExists = await tx.user.findFirst({
          where: { role: 'ADMIN' },
          select: { id: true },
        });
        if (adminExists) {
          throw new Error('ALREADY_INITIALIZED');
        }
        return this.usersService.createWithTx(tx, {
          username: dto.username,
          email: dto.email,
          password: dto.password,
          role: 'ADMIN',
        });
      });
      return { success: true, data: user };
    } catch (err) {
      if (err instanceof Error && err.message === 'ALREADY_INITIALIZED') {
        return {
          success: false,
          error: {
            code: 'ALREADY_INITIALIZED',
            message: 'Admin account already exists',
          },
        };
      }
      throw err;
    }
  }
}
