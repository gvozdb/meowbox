import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './common/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SitesModule } from './sites/sites.module';
import { DeployModule } from './deploy/deploy.module';
import { DatabasesModule } from './databases/databases.module';
import { SslModule } from './ssl/ssl.module';
import { BackupsModule } from './backups/backups.module';
import { CronModule } from './cron/cron.module';
import { SystemCronModule } from './system-cron/system-cron.module';
import { MigrationHostpanelModule } from './migration-hostpanel/migration-hostpanel.module';
import { FirewallModule } from './firewall/firewall.module';
import { CountryBlockModule } from './country-block/country-block.module';
import { NginxModule } from './nginx/nginx.module';
import { PhpModule } from './php/php.module';
import { FilesModule } from './files/files.module';
import { NotificationsModule } from './notifications/notifications.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { SystemModule } from './system/system.module';
import { LogsModule } from './logs/logs.module';
import { ProcessesModule } from './processes/processes.module';
import { AuditModule } from './audit/audit.module';
import { GatewayModule } from './gateway/gateway.module';
import { ProxyModule } from './proxy/proxy.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { StorageModule } from './storage/storage.module';
import { HealthModule } from './health/health.module';
import { MigrationModule } from './migration/migration.module';
import { AiModule } from './ai/ai.module';
import { PanelSettingsModule } from './panel-settings/panel-settings.module';
import { StorageLocationsModule } from './storage-locations/storage-locations.module';
import { DnsModule } from './dns/dns.module';
import { ServicesModule } from './services/services.module';
import { PanelUpdateModule } from './panel-update/panel-update.module';
import { AdminSecurityModule } from './admin-security/admin-security.module';
import { VpnModule } from './vpn/vpn.module';
import { IpAllowlistGuard } from './admin-security/ip-allowlist.guard';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ProxyAuthGuard } from './common/guards/proxy-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { CustomThrottlerGuard } from './common/guards/throttler-tracker.guard';

@Module({
  imports: [
    // --- Config ---
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../.env',
    }),

    // --- Security: Rate limiting ---
    // Лимиты переопределяются через env, чтобы ужесточать на продакшене
    // без релиза: RATELIMIT_SHORT_TTL_MS / _LIMIT, RATELIMIT_MEDIUM_*, RATELIMIT_LONG_*.
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: Number(process.env.RATELIMIT_SHORT_TTL_MS) || 1000,
        limit: Number(process.env.RATELIMIT_SHORT_LIMIT) || 10,
      },
      {
        name: 'medium',
        ttl: Number(process.env.RATELIMIT_MEDIUM_TTL_MS) || 10000,
        limit: Number(process.env.RATELIMIT_MEDIUM_LIMIT) || 50,
      },
      {
        name: 'long',
        ttl: Number(process.env.RATELIMIT_LONG_TTL_MS) || 60000,
        limit: Number(process.env.RATELIMIT_LONG_LIMIT) || 200,
      },
    ]),

    // --- Core ---
    PrismaModule,
    GatewayModule,
    AuthModule,
    UsersModule,
    SitesModule,
    DeployModule,
    DatabasesModule,
    SslModule,
    BackupsModule,
    CronModule,
    SystemCronModule,
    MigrationHostpanelModule,
    FirewallModule,
    CountryBlockModule,
    NginxModule,
    PhpModule,
    FilesModule,
    NotificationsModule,
    MonitoringModule,
    SystemModule,
    LogsModule,
    ProcessesModule,
    AuditModule,
    SchedulerModule,
    ProxyModule,
    DashboardModule,
    StorageModule,
    HealthModule,
    MigrationModule,
    AiModule,
    PanelSettingsModule,
    StorageLocationsModule,
    DnsModule,
    ServicesModule,
    PanelUpdateModule,
    AdminSecurityModule,
    VpnModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // IP allowlist первым в цепочке — фильтрует ВСЕ запросы (включая
    // /auth/login и /auth/refresh), кроме явных исключений (loopback,
    // /api/proxy/* для master↔slave). Если allowlist выключен — пропускает.
    {
      provide: APP_GUARD,
      useClass: IpAllowlistGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ProxyAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule {}
