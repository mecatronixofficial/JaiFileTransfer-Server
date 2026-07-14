import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';

import { FileRecord, FileSchema } from '../files/schemas/file.schema';
import { Folder, FolderSchema } from '../folders/schemas/folder.schema';
import { Transfer, TransferSchema } from '../transfers/schemas/transfer.schema';
import { SharedLink, SharedLinkSchema } from '../links/schemas/link.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FileRecord.name, schema: FileSchema },
      { name: Folder.name, schema: FolderSchema },
      { name: Transfer.name, schema: TransferSchema },
      { name: SharedLink.name, schema: SharedLinkSchema },
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
