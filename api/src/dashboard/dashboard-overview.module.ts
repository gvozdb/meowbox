import { Module } from '@nestjs/common';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardQueryService } from './dashboard-query.service';
import { DashboardDiagnosticsService } from './dashboard-diagnostics.service';

@Module({
  providers: [
    DashboardOverviewService,
    DashboardQueryService,
    DashboardDiagnosticsService,
  ],
  exports: [DashboardOverviewService],
})
export class DashboardOverviewModule {}

