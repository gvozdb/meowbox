import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

interface JwtUser {
  id: string;
  role: string;
}

@Controller('audit-logs')
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('action') action?: string,
    @Query('userId') filterUserId?: string,
    @Query('entity') entity?: string,
    @Query('entityId') entityId?: string,
    @CurrentUser() _user?: JwtUser,
  ) {
    // Clamp обоих параметров: page=0/-5 даёт отрицательный skip → Prisma 500.
    // perPage=NaN/0 → take=0 → возврат пустых результатов; ставим минимум 1.
    const parsedPerPage = parseInt(perPage || '50', 10);
    const take = Math.min(Math.max(1, Number.isFinite(parsedPerPage) ? parsedPerPage : 50), 100);
    const parsedPage = parseInt(page || '1', 10);
    const safePage = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);
    const skip = (safePage - 1) * take;

    const where: Record<string, unknown> = {};
    if (action) where.action = action;
    if (filterUserId) where.userId = filterUserId;
    if (entity) where.entity = entity;
    if (entityId) where.entityId = entityId;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: {
          user: { select: { id: true, username: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      success: true,
      data: logs,
      meta: {
        page: safePage,
        perPage: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }
}
