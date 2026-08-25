import { Injectable, Inject, forwardRef, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException, Logger } from '@nestjs/common';
import { UserRole } from '../common/enums';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BackupExportsService } from '../backups/backup-exports.service';
import { hashPassword, verifyPassword } from '../common/crypto/argon2.helper';

type PrismaTx = Prisma.TransactionClient;
const LOCAL_IDENTITY_KIND = 'LOCAL';
const RESERVED_FEDERATED_USERNAME_PREFIX = '__meowbox_federated_';
const RESERVED_FEDERATED_EMAIL_DOMAIN = '@federation.invalid';

function assertLocalIdentityNames(username?: string, email?: string): void {
  if (
    username?.toLowerCase().startsWith(RESERVED_FEDERATED_USERNAME_PREFIX) ||
    email?.toLowerCase().endsWith(RESERVED_FEDERATED_EMAIL_DOMAIN)
  ) {
    throw new ConflictException('Username or email is reserved');
  }
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger('UsersService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BackupExportsService))
    private readonly backupExports: BackupExportsService,
  ) {}

  async findByUsername(username: string) {
    return this.prisma.user.findFirst({
      where: { username, identityKind: LOCAL_IDENTITY_KIND },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findFirst({
      where: { id, identityKind: LOCAL_IDENTITY_KIND },
    });
  }

  async create(data: {
    username: string;
    email: string;
    password: string;
    role: string;
  }) {
    return this.createWithTx(this.prisma, data);
  }

  /**
   * Создание пользователя в контексте переданной транзакции.
   * Используется setup-контроллером для атомарной проверки "первый ADMIN".
   */
  async createWithTx(
    tx: PrismaService | PrismaTx,
    data: { username: string; email: string; password: string; role: string },
  ) {
    assertLocalIdentityNames(data.username, data.email);
    const existing = await tx.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existing) {
      throw new ConflictException('Username or email already exists');
    }

    const passwordHash = await hashPassword(data.password);

    return tx.user.create({
      data: {
        username: data.username,
        email: data.email,
        passwordHash,
        identityKind: LOCAL_IDENTITY_KIND,
        role: data.role as UserRole,
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        totpEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      where: { identityKind: LOCAL_IDENTITY_KIND },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        totpEnabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Проверка текущего пароля — для защищённых внешних эндпоинтов (/users/:id).
   * Использует constant-time argon2.verify.
   */
  async verifyPassword(id: string, currentPassword: string): Promise<void> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }

  async update(id: string, data: { username?: string; email?: string; role?: string; password?: string }) {
    assertLocalIdentityNames(data.username, data.email);
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Хешим пароль ДО транзакции — argon2 медленный, держать BEGIN IMMEDIATE
    // открытым на сотни мс заблокирует SQLite-writer для остальных запросов.
    const updateData: Record<string, unknown> = {};
    if (data.username) updateData.username = data.username;
    if (data.email) updateData.email = data.email;
    if (data.role) updateData.role = data.role as UserRole;
    if (data.password) {
      updateData.passwordHash = await hashPassword(data.password);
    }

    // TOCTOU: уникальность username/email раньше проверялась findUnique → update
    // вне транзакции. Два параллельных запроса успевали оба пройти проверку и
    // один падал с UNIQUE constraint (500 вместо 409). Теперь проверка и update
    // в одной транзакции — гонка невозможна.
    return this.prisma.$transaction(async (tx) => {
      if (user.role === UserRole.ADMIN && data.role && data.role !== UserRole.ADMIN) {
        const localAdminCount = await tx.user.count({
          where: { identityKind: LOCAL_IDENTITY_KIND, role: UserRole.ADMIN },
        });
        if (localAdminCount <= 1) {
          throw new ForbiddenException('Cannot demote the last local admin');
        }
      }
      if (data.username && data.username !== user.username) {
        const exists = await tx.user.findUnique({ where: { username: data.username }, select: { id: true } });
        if (exists && exists.id !== id) {
          throw new ConflictException('Username already taken');
        }
      }
      if (data.email && data.email !== user.email) {
        const exists = await tx.user.findUnique({ where: { email: data.email }, select: { id: true } });
        if (exists && exists.id !== id) {
          throw new ConflictException('Email already taken');
        }
      }
      return tx.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          totpEnabled: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });
  }

  async updateTotpSecret(id: string, secret: string) {
    const result = await this.prisma.user.updateMany({
      where: { id, identityKind: LOCAL_IDENTITY_KIND },
      data: { totpSecret: secret },
    });
    if (result.count !== 1) throw new NotFoundException('User not found');
  }

  async enableTotp(id: string) {
    const result = await this.prisma.user.updateMany({
      where: { id, identityKind: LOCAL_IDENTITY_KIND },
      data: { totpEnabled: true },
    });
    if (result.count !== 1) throw new NotFoundException('User not found');
  }

  async disableTotp(id: string) {
    const result = await this.prisma.user.updateMany({
      where: { id, identityKind: LOCAL_IDENTITY_KIND },
      data: { totpEnabled: false, totpSecret: null },
    });
    if (result.count !== 1) throw new NotFoundException('User not found');
  }

  async delete(id: string, actorId: string) {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (id === actorId) {
      throw new ForbiddenException('Cannot delete the current local user');
    }

    // Чистим S3-объекты экспортов до cascade-удаления.
    // Cascade снесёт записи `BackupExport` автоматически, но S3 объекты —
    // нет, и они зависнут навсегда (биллинг + утечка данных).
    try {
      await this.backupExports.cleanupArtifactsForUser(id);
    } catch (err) {
      this.logger.warn(`Failed to cleanup export artifacts for user ${id}: ${(err as Error).message}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findFirst({
        where: { id, identityKind: LOCAL_IDENTITY_KIND },
        select: { id: true, role: true },
      });
      if (!current) throw new NotFoundException('User not found');
      if (current.role === UserRole.ADMIN) {
        const localAdminCount = await tx.user.count({
          where: { identityKind: LOCAL_IDENTITY_KIND, role: UserRole.ADMIN },
        });
        if (localAdminCount <= 1) {
          throw new ForbiddenException('Cannot delete the last local admin');
        }
      }
      await tx.user.delete({ where: { id } });
    });
  }
}
