import { Module } from '@nestjs/common';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [ProxyModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
