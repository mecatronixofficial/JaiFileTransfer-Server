import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Transfer, TransferSchema } from './schemas/transfer.schema';
import { TransfersService } from './transfers.service';
import { TransfersController } from './transfers.controller';
import { LinksModule } from '../links/links.module';
import { MailModule } from '../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { R2Module } from '../r2/r2.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';
import { SharedLink, SharedLinkSchema } from '../links/schemas/link.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transfer.name, schema: TransferSchema },
      { name: Folder.name, schema: FolderSchema },
      { name: SharedLink.name, schema: SharedLinkSchema },
      { name: User.name, schema: UserSchema },
    ]),
    LinksModule,
    MailModule,
    FilesModule,
    R2Module,
    NotificationsModule,
  ],
  controllers: [TransfersController],
  providers: [TransfersService],
  exports: [TransfersService],
})
export class TransfersModule {}
