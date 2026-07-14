import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

import { MailService } from './mail.service';
import { MailController } from './mail.controller';
import { WebhookController } from './webhook.controller';
import { MailLog, MailLogSchema } from './schemas/mail-log.schema';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: MailLog.name, schema: MailLogSchema }]),
  ],
  controllers: [MailController, WebhookController],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
