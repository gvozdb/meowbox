import { Module } from '@nestjs/common';
import { CountryBlockController } from './country-block.controller';
import { CountryBlockService } from './country-block.service';
import { PanelSettingsModule } from '../panel-settings/panel-settings.module';

@Module({
  imports: [PanelSettingsModule],
  controllers: [CountryBlockController],
  providers: [CountryBlockService],
  exports: [CountryBlockService],
})
export class CountryBlockModule {}
