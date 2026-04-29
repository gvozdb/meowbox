import {
  Injectable, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AgentRelayService } from '../gateway/agent-relay.service';
import {
  CreateStorageLocationDto, UpdateStorageLocationDto,
} from './storage-locations.dto';

// Хранилища, которые поддерживают движок Restic.
const RESTIC_TYPES = new Set(['LOCAL', 'S3']);

export interface StorageLocationView {
  id: string;
  name: string;
  type: string;
  config: Record<string, string>;
  resticEnabled: boolean;
  // resticPassword НЕ возвращается в API (показывается только один раз при создании)
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class StorageLocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRelay: AgentRelayService,
  ) {}

  async list(): Promise<StorageLocationView[]> {
    const rows = await this.prisma.storageLocation.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async getById(id: string) {
    const row = await this.prisma.storageLocation.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Storage location not found');
    return row;
  }

  // Полный конфиг, включая resticPassword — только для внутреннего использования (передачи в агент).
  // НЕ возвращать пользователю.
  async getFullConfigForAgent(id: string): Promise<{
    id: string;
    name: string;
    type: string;
    config: Record<string, string>;
    resticPassword: string | null;
  }> {
    const row = await this.getById(id);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      config: this.safeParseConfig(row.config),
      resticPassword: row.resticPassword,
    };
  }

  async create(dto: CreateStorageLocationDto): Promise<{
    location: StorageLocationView;
    // Возвращается один раз при создании; НЕ показывается в последующих GET
    resticPassword?: string;
  }> {
    // Валидация конфига по type
    this.validateConfigForType(dto.type, dto.config);

    // Уникальность имени
    const existing = await this.prisma.storageLocation.findUnique({
      where: { name: dto.name },
    });
    if (existing) throw new ConflictException('Хранилище с таким именем уже есть');

    const resticEnabled = RESTIC_TYPES.has(dto.type);

    // Пароль Restic: если тип поддерживает — берём переданный, иначе стандартный
    // фоллбек «qwerty» (сознательный выбор пользователя: простота > стойкость).
    let resticPassword: string | null = null;
    if (resticEnabled) {
      resticPassword = dto.resticPassword?.trim() || 'qwerty';
    }

    const created = await this.prisma.storageLocation.create({
      data: {
        name: dto.name.trim(),
        type: dto.type,
        config: JSON.stringify(dto.config),
        resticEnabled,
        resticPassword,
      },
    });

    return {
      location: this.toView(created),
      // показываем пароль один раз
      resticPassword: resticPassword || undefined,
    };
  }

  async update(id: string, dto: UpdateStorageLocationDto): Promise<StorageLocationView> {
    const row = await this.getById(id);

    const data: { name?: string; config?: string } = {};
    if (dto.name !== undefined) {
      const existing = await this.prisma.storageLocation.findFirst({
        where: { name: dto.name, NOT: { id } },
      });
      if (existing) throw new ConflictException('Хранилище с таким именем уже есть');
      data.name = dto.name.trim();
    }
    if (dto.config !== undefined) {
      this.validateConfigForType(row.type, dto.config);
      data.config = JSON.stringify(dto.config);
    }

    const updated = await this.prisma.storageLocation.update({
      where: { id },
      data,
    });
    return this.toView(updated);
  }

  async remove(id: string): Promise<void> {
    const row = await this.getById(id);

    // Нельзя удалить хранилище, если на него есть активные Backup-записи
    const backupsCount = await this.prisma.backup.count({
      where: { storageLocationId: id },
    });
    if (backupsCount > 0) {
      throw new BadRequestException(
        `На это хранилище ссылаются ${backupsCount} бэкап(ов). Сначала удали их.`,
      );
    }

    await this.prisma.storageLocation.delete({ where: { id: row.id } });
  }

  /**
   * Тест доступа к хранилищу (для Restic — init/list; для TAR — ещё не реализовано здесь,
   * агент проверит при upload).
   */
  async test(id: string, siteName: string): Promise<{ success: boolean; error?: string }> {
    const row = await this.getById(id);
    if (!row.resticEnabled || !row.resticPassword) {
      return { success: false, error: 'Тест реализован только для Restic-совместимых хранилищ (LOCAL/S3)' };
    }

    if (!this.agentRelay.isAgentConnected()) {
      return { success: false, error: 'Agent offline' };
    }

    // Проверяем через agent.restic:test
    const res = await this.agentRelay.emitToAgent<{ success: boolean; error?: string }>(
      'restic:test',
      {
        siteName,
        storage: {
          type: row.type as 'LOCAL' | 'S3',
          config: this.safeParseConfig(row.config),
          password: row.resticPassword,
        },
      },
      60_000,
    );
    if (!res.success) {
      return { success: false, error: res.error || 'test failed' };
    }
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toView(r: {
    id: string; name: string; type: string; config: string;
    resticEnabled: boolean; createdAt: Date; updatedAt: Date;
  }): StorageLocationView {
    // ВАЖНО: не возвращаем секреты (accessKey/secretKey/oauthToken/password)
    // наружу через API. Чистим конфиг при сериализации.
    const raw = this.safeParseConfig(r.config);
    const safe = this.redactSecrets(r.type, raw);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      config: safe,
      resticEnabled: r.resticEnabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private safeParseConfig(raw: string): Record<string, string> {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string>;
    } catch { /* ignore */ }
    return {};
  }

  private redactSecrets(type: string, cfg: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = { ...cfg };
    // Секреты: заменяем на маркер (UI будет показывать "●●●● задан" / "не задан")
    const secretKeys = ['secretKey', 'accessKey', 'oauthToken', 'password'];
    for (const k of secretKeys) {
      if (redacted[k]) redacted[k] = '***';
    }
    return redacted;
  }

  private validateConfigForType(type: string, cfg: Record<string, string>): void {
    const required: Record<string, string[]> = {
      S3: ['bucket', 'accessKey', 'secretKey'],
      YANDEX_DISK: ['oauthToken'],
      CLOUD_MAIL_RU: ['username', 'password'],
      LOCAL: [], // ничего обязательного
    };
    const need = required[type];
    if (!need) throw new BadRequestException(`Unsupported storage type: ${type}`);
    for (const key of need) {
      if (!cfg[key] || !String(cfg[key]).trim()) {
        throw new BadRequestException(`Отсутствует обязательное поле: ${key}`);
      }
    }
    // S3 endpoint — если задан, должен быть https://
    if (type === 'S3' && cfg.endpoint) {
      if (!/^https?:\/\//i.test(cfg.endpoint)) {
        throw new BadRequestException('endpoint должен начинаться с http(s)://');
      }
    }
  }
}
