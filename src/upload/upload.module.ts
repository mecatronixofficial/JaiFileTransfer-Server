import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';

import { R2Module } from '../r2/r2.module';
import { FilesModule } from '../files/files.module';
import { TransfersModule } from '../transfers/transfers.module';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';
import {
  UploadSession,
  UploadSessionSchema,
} from './schemas/upload-session.schema';

@Module({
  imports: [
    R2Module,
    FilesModule,
    TransfersModule,
    MongooseModule.forFeature([
      { name: Folder.name, schema: FolderSchema },
      { name: UploadSession.name, schema: UploadSessionSchema },
    ]),
  ],
  providers: [UploadService],
  controllers: [UploadController],
  exports: [UploadService],
})
export class UploadModule {}
