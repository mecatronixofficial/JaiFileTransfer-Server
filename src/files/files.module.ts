import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { FilesCronService } from './files.cron.service';

import { FileRecord, FileSchema } from './schemas/file.schema';
import { Share, ShareSchema } from '../shares/schemas/share.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';

import { R2Module } from '../r2/r2.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FileRecord.name, schema: FileSchema },
      { name: Share.name, schema: ShareSchema },
      { name: User.name, schema: UserSchema },
      { name: Folder.name, schema: FolderSchema },
    ]),
    R2Module,
    NotificationsModule,
  ],
  controllers: [FilesController],
  providers: [FilesService, FilesCronService],
  exports: [FilesService, MongooseModule],
})
export class FilesModule {}
