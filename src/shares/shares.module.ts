import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SharesService } from './shares.service';
import { SharesController } from './shares.controller';

import { Share, ShareSchema } from './schemas/share.schema';
import { ShareAccess, ShareAccessSchema } from './schemas/share-access.schema';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

import { R2Module } from '../r2/r2.module';
import { NotificationsModule } from '../notifications/notifications.module';
// MailModule is @Global() — no import needed here

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Share.name, schema: ShareSchema },
      { name: ShareAccess.name, schema: ShareAccessSchema },
      { name: FileRecord.name, schema: FileSchema },
      { name: Folder.name, schema: FolderSchema },
      { name: User.name, schema: UserSchema },
    ]),
    R2Module,
    NotificationsModule,
  ],
  controllers: [SharesController],
  providers: [SharesService],
  exports: [SharesService, MongooseModule],
})
export class SharesModule {}
