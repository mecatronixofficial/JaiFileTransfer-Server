import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { FileRecord, FileDocument } from '../files/schemas/file.schema';
import { Folder, FolderDocument } from '../folders/schemas/folder.schema';
import { Transfer, TransferDocument } from '../transfers/schemas/transfer.schema';
import { SharedLink, SharedLinkDocument } from '../links/schemas/link.schema';
import { Role } from '../common/enums';

type SearchType = 'file' | 'folder' | 'transfer' | 'link';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  private async measured<T>(operation: string, query: { maxTimeMS(ms: number): { exec(): Promise<T> } }): Promise<T> {
    const started = performance.now();
    try {
      return await query.maxTimeMS(3000).exec();
    } finally {
      const durationMs = Math.round(performance.now() - started);
      const measurement = { operation, durationMs };
      if (durationMs >= 250) this.logger.warn(measurement);
      else this.logger.debug(measurement);
    }
  }

  constructor(
    @InjectModel(FileRecord.name) private readonly fileModel: Model<FileDocument>,
    @InjectModel(Folder.name) private readonly folderModel: Model<FolderDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(SharedLink.name) private readonly linkModel: Model<SharedLinkDocument>,
  ) {}

  async search(
    q: string,
    user: any,
    page = 1,
    limit = 20,
    type?: SearchType,
  ) {
    const safeLimit = Math.min(limit, 50);
    const skip = (page - 1) * safeLimit;

    // Escape regex special chars to prevent ReDoS
    const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = { $regex: escaped, $options: 'i' };

    const isUser = user.role === Role.USER;

    const fileFilter: any = {
      isDeleted: false,
      $or: [
        { fileName: regex },
        { originalName: regex },
        { description: regex },
        { tags: regex },
      ],
    };

    const folderFilter: any = {
      isDeleted: false,
      $or: [{ name: regex }, { description: regex }],
    };

    const transferFilter: any = {
      $or: [
        { title: regex },
        { subject: regex },
        { message: regex },
        { recipients: regex },
      ],
    };

    const linkFilter: any = {
      $or: [{ shortCode: regex }, { url: regex }],
    };

    if (isUser) {
      fileFilter.$and = [
        { $or: [{ uploadedBy: user._id }, { sharedWith: user._id }] },
      ];
      folderFilter.createdBy = user._id;
      transferFilter.$and = [
        {
          $or: [
            { senderId: user._id },
            { recipients: user._id },
            { recipients: user.email },
          ],
        },
      ];
      linkFilter.senderId = user._id;
    }

    const searchFiles = !type || type === 'file';
    const searchFolders = !type || type === 'folder';
    const searchTransfers = !type || type === 'transfer';
    const searchLinks = !type || type === 'link';

    const [
      files, fileTotal,
      folders, folderTotal,
      transfers, transferTotal,
      links, linkTotal,
    ] = await Promise.all([
      searchFiles
        ? this.measured('file.find', this.fileModel
            .find(fileFilter)
            .select('fileName originalName size mimeType tags uploadedBy folderId createdAt')
            .populate('uploadedBy', 'name email')
            .populate('folderId', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean())
        : Promise.resolve([]),

      searchFiles ? this.measured('file.count', this.fileModel.countDocuments(fileFilter)) : Promise.resolve(0),

      searchFolders
        ? this.measured('folder.find', this.folderModel
            .find(folderFilter)
            .select('name createdBy createdAt')
            .populate('createdBy', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean())
        : Promise.resolve([]),

      searchFolders ? this.measured('folder.count', this.folderModel.countDocuments(folderFilter)) : Promise.resolve(0),

      searchTransfers
        ? this.measured('transfer.find', this.transferModel
            .find(transferFilter)
            .select('title method recipients status expiresAt senderId totalSize fileCount folderCount createdAt')
            .populate('senderId', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean())
        : Promise.resolve([]),

      searchTransfers
        ? this.measured('transfer.count', this.transferModel.countDocuments(transferFilter))
        : Promise.resolve(0),

      searchLinks
        ? this.measured('link.find', this.linkModel
            .find(linkFilter)
            .select('shortCode url status senderId transferId fileCount totalSize expiresAt createdAt')
            .populate('senderId', 'name email')
            .populate('transferId', 'title')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean())
        : Promise.resolve([]),

      searchLinks ? this.measured('link.count', this.linkModel.countDocuments(linkFilter)) : Promise.resolve(0),
    ]);

    const total = fileTotal + folderTotal + transferTotal + linkTotal;

    return {
      files,
      folders,
      transfers,
      links,
      total,
      counts: {
        files: fileTotal,
        folders: folderTotal,
        transfers: transferTotal,
        links: linkTotal,
      },
      page,
      limit: safeLimit,
    };
  }
}
