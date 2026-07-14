import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FoldersService } from './folders.service';
import { FoldersController } from './folders.controller';

import { Folder, FolderSchema } from './schemas/folder.schema';
import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Folder.name, schema: FolderSchema },
      { name: FileRecord.name, schema: FileSchema },
    ]),
    // ⚠️ forwardRef avoids circular dependency issues (common in file systems)
    forwardRef(() => FilesModule),
  ],
  providers: [FoldersService],
  controllers: [FoldersController],
  exports: [FoldersService],
})
export class FoldersModule {}
