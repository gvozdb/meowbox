import { Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { SitesModule } from '../sites/sites.module';
import { TransfersModule } from '../transfers/transfers.module';
import { FileTransferService } from './file-transfer.service';

@Module({
  imports: [SitesModule, TransfersModule],
  controllers: [FilesController],
  providers: [FilesService, FileTransferService],
})
export class FilesModule {}
