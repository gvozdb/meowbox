import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AuthModule } from '../auth/auth.module';
import { DashboardOverviewModule } from './dashboard-overview.module';

@Module({
  imports: [AuthModule, DashboardOverviewModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
