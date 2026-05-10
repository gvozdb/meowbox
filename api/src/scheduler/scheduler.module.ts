import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { PrismaModule } from '../common/prisma.module';
import { BackupsModule } from '../backups/backups.module';
import { SslModule } from '../ssl/ssl.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';
import { DnsModule } from '../dns/dns.module';
import { CountryBlockModule } from '../country-block/country-block.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    forwardRef(() => BackupsModule),
    forwardRef(() => SslModule),
    forwardRef(() => GatewayModule),
    NotificationsModule,
    AuthModule,
    PanelSettingsModule,
    DnsModule,
    CountryBlockModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
