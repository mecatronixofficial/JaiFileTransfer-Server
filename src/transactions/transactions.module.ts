import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { Transfer, TransferSchema } from '../transfers/schemas/transfer.schema';
import {
  Notification,
  NotificationSchema,
} from '../notifications/schemas/notification.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FileRecord.name, schema: FileSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: Notification.name, schema: NotificationSchema },
    ]),
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
