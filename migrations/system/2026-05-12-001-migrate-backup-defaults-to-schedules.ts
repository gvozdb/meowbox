import type { SystemMigration } from './_types';

/**
 * Переносит одиночный `PanelSetting('backup-defaults')` в множественные
 * `SiteBackupSchedule`. После переноса старый PanelSetting НЕ удаляется
 * (для отката), но помечается полем `migrated_to_schedule_id` в JSON-value.
 *
 * Идемпотентность:
 *  - Если backup-defaults уже мигрирован (есть migrated_to_schedule_id и
 *    соответствующий SiteBackupSchedule существует) → пропускаем.
 *  - Если PanelSetting('backup-defaults') не существует → нечего переносить.
 */
const migration: SystemMigration = {
  id: '2026-05-12-001-migrate-backup-defaults-to-schedules',
  description: 'Переносит одиночный backup-defaults в множественные SiteBackupSchedule',

  async up(ctx) {
    const setting = await ctx.prisma.panelSetting.findUnique({
      where: { key: 'backup-defaults' },
    });

    if (!setting) {
      ctx.log('PanelSetting(backup-defaults) не найден — нечего переносить');
      return;
    }

    let value: Record<string, unknown> = {};
    try {
      value = JSON.parse(setting.value || '{}');
    } catch {
      ctx.log(`backup-defaults содержит невалидный JSON — пропускаю`);
      return;
    }

    // Проверяем, не было ли уже миграции.
    const existingId = typeof value.migrated_to_schedule_id === 'string'
      ? value.migrated_to_schedule_id
      : null;
    if (existingId) {
      const exists = await ctx.prisma.siteBackupSchedule.findUnique({
        where: { id: existingId },
      });
      if (exists) {
        ctx.log(`backup-defaults уже мигрирован в schedule ${existingId} — пропускаю`);
        return;
      }
    }

    if (ctx.dryRun) {
      ctx.log(`[dry-run] создам SiteBackupSchedule из backup-defaults`);
      return;
    }

    // Маппинг старого JSON в поля новой модели.
    // Совместимо с PanelSettingsService.getBackupDefaults() shape.
    const enabled = value.enabled !== false;
    const schedule = typeof value.schedule === 'string' && value.schedule.trim() !== ''
      ? value.schedule.trim()
      : null;
    const type = typeof value.type === 'string' ? value.type : 'FULL';
    const engine = typeof value.engine === 'string' ? value.engine : 'RESTIC';
    const storageLocationIdsArr = Array.isArray(value.storageLocationIds)
      ? value.storageLocationIds.filter((x): x is string => typeof x === 'string')
      : [];
    const retention = (value.retention as Record<string, unknown>) || {};
    const excludePathsArr = Array.isArray(value.excludePaths)
      ? value.excludePaths.filter((x): x is string => typeof x === 'string')
      : [];
    const excludeTableDataArr = Array.isArray(value.excludeTableData)
      ? value.excludeTableData.filter((x): x is string => typeof x === 'string')
      : [];

    // Если не было настроено никакого расписания — не создаём пустой шедуль
    if (!schedule && !storageLocationIdsArr.length) {
      ctx.log('backup-defaults пуст (нет schedule + нет хранилищ) — не создаю шедуль');
      // Помечаем как обработанный, чтобы не пытаться снова.
      value.migrated_to_schedule_id = null;
      value.migrated_at = new Date().toISOString();
      await ctx.prisma.panelSetting.update({
        where: { key: 'backup-defaults' },
        data: { value: JSON.stringify(value) },
      });
      return;
    }

    const created = await ctx.prisma.siteBackupSchedule.create({
      data: {
        name: 'Default (migrated)',
        enabled,
        type,
        engine,
        storageLocationIds: JSON.stringify(storageLocationIdsArr),
        schedule,
        keepDaily: typeof retention.keepDaily === 'number' ? retention.keepDaily : 7,
        keepWeekly: typeof retention.keepWeekly === 'number' ? retention.keepWeekly : 4,
        keepMonthly: typeof retention.keepMonthly === 'number' ? retention.keepMonthly : 6,
        keepYearly: typeof retention.keepYearly === 'number' ? retention.keepYearly : 1,
        retentionDays: typeof value.retentionDays === 'number' ? (value.retentionDays as number) : 7,
        excludePaths: JSON.stringify(excludePathsArr),
        excludeTableData: JSON.stringify(excludeTableDataArr),
        checkEnabled: value.checkEnabled === true,
        checkSchedule: typeof value.checkSchedule === 'string' ? (value.checkSchedule as string) : null,
        checkReadData: value.checkReadData === true,
        checkReadDataSubset: typeof value.checkReadDataSubset === 'string'
          ? (value.checkReadDataSubset as string)
          : null,
        checkMinIntervalHours: typeof value.checkMinIntervalHours === 'number'
          ? (value.checkMinIntervalHours as number)
          : 168,
        notificationMode: 'INSTANT',
        digestSchedule: null,
        storageLocations: storageLocationIdsArr.length > 0
          ? { connect: storageLocationIdsArr.map((id) => ({ id })) }
          : undefined,
      },
    });

    ctx.log(`Создан SiteBackupSchedule ${created.id} ("${created.name}")`);

    // Помечаем PanelSetting как мигрированный (не удаляем — на случай отката).
    value.migrated_to_schedule_id = created.id;
    value.migrated_at = new Date().toISOString();
    await ctx.prisma.panelSetting.update({
      where: { key: 'backup-defaults' },
      data: { value: JSON.stringify(value) },
    });

    ctx.log('PanelSetting(backup-defaults) помечен как мигрированный');
  },

  async down(ctx) {
    const setting = await ctx.prisma.panelSetting.findUnique({
      where: { key: 'backup-defaults' },
    });
    if (!setting) return;

    let value: Record<string, unknown> = {};
    try { value = JSON.parse(setting.value || '{}'); } catch { return; }

    const id = typeof value.migrated_to_schedule_id === 'string'
      ? value.migrated_to_schedule_id
      : null;
    if (!id) return;

    await ctx.prisma.siteBackupSchedule.deleteMany({ where: { id } });
    delete value.migrated_to_schedule_id;
    delete value.migrated_at;
    await ctx.prisma.panelSetting.update({
      where: { key: 'backup-defaults' },
      data: { value: JSON.stringify(value) },
    });
    ctx.log(`Откатил SiteBackupSchedule ${id}`);
  },
};

export default migration;
