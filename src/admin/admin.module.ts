import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

import { User, UserSchema } from '../users/schemas/user.schema';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { Share, ShareSchema } from '../shares/schemas/share.schema';
import { ShareAccess, ShareAccessSchema } from '../shares/schemas/share-access.schema';
import { Transfer, TransferSchema } from '../transfers/schemas/transfer.schema';
import { SharedLink, SharedLinkSchema } from '../links/schemas/link.schema';
import { UploadSession, UploadSessionSchema } from '../upload/schemas/upload-session.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: FileRecord.name, schema: FileSchema },
      { name: Share.name, schema: ShareSchema },
      { name: ShareAccess.name, schema: ShareAccessSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: SharedLink.name, schema: SharedLinkSchema },
      { name: UploadSession.name, schema: UploadSessionSchema },
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
