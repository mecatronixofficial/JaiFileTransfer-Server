import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SharedLink, SharedLinkSchema } from './schemas/link.schema';
import { LinkAccess, LinkAccessSchema } from './schemas/link-access.schema';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';
import { LinksService } from './links.service';
import { LinksController } from './links.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SharedLink.name, schema: SharedLinkSchema },
      { name: LinkAccess.name, schema: LinkAccessSchema },
      { name: FileRecord.name, schema: FileSchema },
      { name: Folder.name, schema: FolderSchema },
    ]),
    NotificationsModule,
  ],
  controllers: [LinksController],
  providers: [LinksService],
  exports: [LinksService, MongooseModule],
})
export class LinksModule {}
