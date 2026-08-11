import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';

import { MailService } from './mail.service';
import { SmtpService } from './smtp.service';
import { MailController } from './mail.controller';
import { MailLog, MailLogSchema } from './schemas/mail-log.schema';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: MailLog.name, schema: MailLogSchema }]),
  ],
  controllers: [MailController],
  providers: [MailService, SmtpService],
  exports: [MailService, SmtpService],
})
export class MailModule {}
