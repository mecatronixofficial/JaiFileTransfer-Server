import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { UsersService } from './users.service';
import { UsersController } from './users.controller';

import { User, UserSchema } from './schemas/user.schema';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { FilesModule } from '../files/files.module';
import { R2Module } from '../r2/r2.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: FileRecord.name, schema: FileSchema },
    ]),
    forwardRef(() => FilesModule),
    R2Module,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
