import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PanelUpdateService } from './panel-update.service';
import { PanelUpdateController } from './panel-update.controller';

@Module({
  imports: [ConfigModule],
  controllers: [PanelUpdateController],
  providers: [PanelUpdateService],
})
export class PanelUpdateModule {}
