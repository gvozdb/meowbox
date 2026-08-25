import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AuthModule } from '../auth/auth.module';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardQueryService } from './dashboard-query.service';
import { DashboardDiagnosticsService } from './dashboard-diagnostics.service';

@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    DashboardOverviewService,
    DashboardQueryService,
    DashboardDiagnosticsService,
  ],
})
export class DashboardModule {}
