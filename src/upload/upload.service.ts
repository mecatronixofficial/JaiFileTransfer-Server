import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { R2Service } from '../r2/r2.service';
import { Folder, FolderDocument } from '../folders/schemas/folder.schema';
import {
  UploadSession,
  UploadSessionDocument,
} from './schemas/upload-session.schema';
import {
  PresignedUrlDto,
  InitiateMultipartDto,
  CompleteMultipartDto,
  GetPartUrlDto,
  FolderUploadDto,
  GetUploadSessionsDto,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
} from './dto/upload.dto';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly multipartPartSize = 50 * 1024 * 1024; // 50 MB
  private readonly multipartThreshold = 100 * 1024 * 1024; // 100 MB
  private readonly presignConcurrency = 10;

  constructor(
    private readonly r2Service: R2Service,
    @InjectModel(Folder.name) private readonly folderModel: Model<FolderDocument>,
    @InjectModel(UploadSession.name)
    private readonly uploadSessionModel: Model<UploadSessionDocument>,
  ) {}

  /* =========================
     HELPERS
  ========================= */
  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private validateFile(mimeType: string, size: number): void {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(`Unsupported file type: ${mimeType}`);
    }
    if (size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${MAX_FILE_SIZE / (1024 ** 3)} GB`,
      );
    }
  }

  private getMultipartPartCount(
    fileSize: number,
    partSize = this.multipartPartSize,
  ): number {
    return Math.ceil(fileSize / partSize);
  }

  private getSessionPartSize(session: UploadSessionDocument): number {
    const stored = Number(session.metadata?.partSize);
    return Number.isFinite(stored) && stored >= 5 * 1024 * 1024
      ? stored
      : this.multipartPartSize;
  }

  private async requireWritableFolder(folderId: string | undefined, userId: string) {
    if (!folderId) return null;
    if (!Types.ObjectId.isValid(folderId)) {
      throw new BadRequestException('Invalid folder ID');
    }
    const folder = await this.folderModel.findOne({
      _id: new Types.ObjectId(folderId),
      createdBy: new Types.ObjectId(userId),
      isDeleted: false,
    });
    if (!folder) throw new BadRequestException('Folder not found or not writable');
    return folder;
  }

  private async requireActiveMultipartSession(uploadId: string, key: string, userId: string) {
    const session = await this.uploadSessionModel.findOne({
      uploadId,
      storageKey: key,
      userId: new Types.ObjectId(userId),
      uploadType: 'multipart',
      status: 'uploading',
    });
    if (!session) throw new NotFoundException('Active multipart upload session not found');
    return session;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
      }),
    );

    return results;
  }

  /* =========================
     PRESIGNED UPLOAD URL (single file)
  ========================= */
  async generatePresignedUrl(dto: PresignedUrlDto, userId: string, organizationId?: string | null) {
    this.validateFile(dto.mimeType, dto.fileSize);
    await this.requireWritableFolder(dto.folderId, userId);

    const safeName = this.sanitizeFileName(dto.fileName);
    const key = this.r2Service.generateKey(safeName, userId);

    const { uploadUrl } = await this.r2Service.generatePresignedUploadUrl(
      key,
      dto.mimeType,
      dto.fileSize,
    );

    const fileId = new Types.ObjectId().toHexString();
    const session = await this.uploadSessionModel.create({
      userId: new Types.ObjectId(userId),
      organizationId: organizationId ? new Types.ObjectId(organizationId) : null,
      folderId: dto.folderId ? new Types.ObjectId(dto.folderId) : null,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      size: dto.fileSize,
      storageKey: key,
      uploadId: null,
      uploadType: 'single',
      status: 'uploading',
      partsCount: 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    this.logger.log(`Presigned URL generated | user=${userId} | file=${dto.fileName} | size=${dto.fileSize}`);

    return {
      url: uploadUrl,
      key,
      fileId,
      uploadSessionId: session._id.toString(),
      expiresIn: this.r2Service.getPresignedUploadExpiry(),
    };
  }

  /* =========================
     MULTIPART — INITIATE
     Optionally returns pre-generated part URLs if partCount is provided.
  ========================= */
  async initiateMultipartUpload(
    dto: InitiateMultipartDto,
    userId: string,
    organizationId?: string | null,
  ) {
    this.validateFile(dto.mimeType, dto.fileSize);
    await this.requireWritableFolder(dto.folderId, userId);

    const safeName = this.sanitizeFileName(dto.fileName);
    const key = this.r2Service.generateKey(safeName, userId);

    const partSize = dto.partSize ?? this.multipartPartSize;
    const expectedPartCount = this.getMultipartPartCount(dto.fileSize, partSize);

    if (dto.partCount && dto.partCount !== expectedPartCount) {
      throw new BadRequestException(
        `partCount must be ${expectedPartCount} for this file size using ${partSize}-byte parts`,
      );
    }

    const uploadId = await this.r2Service.createMultipartUpload(key, dto.mimeType);

    let partUrls: { partNumber: number; uploadUrl: string }[] | undefined;

    if (dto.partCount && dto.partCount > 0) {
      partUrls = await this.mapWithConcurrency(
        Array.from({ length: dto.partCount }),
        this.presignConcurrency,
        async (_, i) => ({
          partNumber: i + 1,
          uploadUrl: await this.r2Service.generatePresignedPartUrl(key, uploadId, i + 1),
        }),
      );
    }

    const fileId = new Types.ObjectId().toHexString();
    const session = await this.uploadSessionModel.create({
      userId: new Types.ObjectId(userId),
      organizationId: organizationId ? new Types.ObjectId(organizationId) : null,
      folderId: dto.folderId ? new Types.ObjectId(dto.folderId) : null,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      size: dto.fileSize,
      storageKey: key,
      uploadId,
      uploadType: 'multipart',
      status: 'uploading',
      partsCount: dto.partCount ?? 0,
      metadata: { partSize },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    this.logger.log(`Multipart initiated | user=${userId} | key=${key} | parts=${dto.partCount ?? 'not pre-generated'}`);

    const urls = partUrls?.map((p) => p.uploadUrl) ?? [];
    return {
      uploadId,
      key,
      fileId,
      uploadSessionId: session._id.toString(),
      urls,
      partSize,
      partCount: expectedPartCount,
      expiresIn: this.r2Service.getPresignedUploadExpiry(),
    };
  }

  /* =========================
     MULTIPART — PRESIGNED PART URL
     Call this endpoint for each part if partCount wasn't provided at initiation.
  ========================= */
  async getPresignedPartUrl(dto: GetPartUrlDto, userId: string) {
    const session = await this.requireActiveMultipartSession(dto.uploadId, dto.key, userId);
    const expectedPartCount = this.getMultipartPartCount(
      session.size,
      this.getSessionPartSize(session),
    );
    if (dto.partNumber > expectedPartCount) {
      throw new BadRequestException(
        `Part number must be between 1 and ${expectedPartCount}`,
      );
    }
    const partUrl = await this.r2Service.generatePresignedPartUrl(
      dto.key,
      dto.uploadId,
      dto.partNumber,
    );

    this.logger.log(`Part URL generated | user=${userId} | key=${dto.key} | part=${dto.partNumber}`);

    return {
      uploadUrl: partUrl,
      partNumber: dto.partNumber,
      expiresIn: this.r2Service.getPresignedUploadExpiry(),
    };
  }

  /* =========================
     MULTIPART — SERVER-SIDE PART UPLOAD FALLBACK
     Used when browser-to-R2 PUT is blocked by CORS/network.
  ========================= */
  async uploadMultipartPart(
    file: Express.Multer.File,
    uploadId: string,
    key: string,
    partNumber: number,
    userId: string,
  ) {
    if (!file) throw new BadRequestException('No multipart part provided');
    if (!Number.isFinite(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new BadRequestException('Part number must be between 1 and 10000');
    }
    if (!uploadId || !key) {
      throw new BadRequestException('uploadId and key are required');
    }

    const session = await this.requireActiveMultipartSession(uploadId, key, userId);

    const etag = await this.r2Service.uploadMultipartPart(
      key,
      uploadId,
      partNumber,
      file.buffer,
    );

    this.logger.log(`Server part uploaded | user=${userId} | key=${key} | part=${partNumber}`);

    return {
      etag,
      partNumber,
      size: file.size,
      uploadSessionId: session._id.toString(),
    };
  }

  /* =========================
     MULTIPART — COMPLETE
  ========================= */
  async completeMultipartUpload(dto: CompleteMultipartDto, userId: string) {
    if (!dto.parts?.length) {
      throw new BadRequestException('Parts list cannot be empty');
    }

    const session = await this.requireActiveMultipartSession(dto.uploadId, dto.key, userId);
    const expectedPartCount = this.getMultipartPartCount(
      session.size,
      this.getSessionPartSize(session),
    );
    const partNumbers = new Set(dto.parts.map((part) => part.partNumber));
    if (dto.parts.length !== expectedPartCount || partNumbers.size !== expectedPartCount) {
      throw new BadRequestException(`Exactly ${expectedPartCount} unique parts are required`);
    }
    for (let partNumber = 1; partNumber <= expectedPartCount; partNumber += 1) {
      if (!partNumbers.has(partNumber)) {
        throw new BadRequestException(`Missing multipart part ${partNumber}`);
      }
    }

    await this.r2Service.completeMultipartUpload(dto.uploadId, dto.key, dto.parts);
    await this.uploadSessionModel.findOneAndUpdate(
      {
        uploadId: dto.uploadId,
        storageKey: dto.key,
        userId: new Types.ObjectId(userId),
      },
      {
        $set: {
          status: 'completed',
          partsCount: dto.parts.length,
          completedAt: new Date(),
          expiresAt: null,
        },
      },
    );

    this.logger.log(`Multipart completed | user=${userId} | key=${dto.key} | parts=${dto.parts.length}`);

    return { key: dto.key, message: 'Upload complete. Save file metadata via POST /api/v1/files' };
  }

  /* =========================
     MULTIPART — ABORT
  ========================= */
  async abortMultipartUpload(uploadId: string, key: string, userId: string) {
    await this.requireActiveMultipartSession(uploadId, key, userId);
    await this.r2Service.abortMultipartUpload(uploadId, key);
    await this.uploadSessionModel.findOneAndUpdate(
      {
        uploadId,
        storageKey: key,
        userId: new Types.ObjectId(userId),
      },
      {
        $set: {
          status: 'aborted',
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      },
    );
    this.logger.log(`Multipart aborted | user=${userId} | key=${key}`);
    return { message: 'Multipart upload aborted and cleaned up' };
  }

  /* =========================
     DIRECT UPLOAD (server-side, no browser CORS needed)
  ========================= */
  async uploadFileDirect(
    file: Express.Multer.File,
    folderId: string | undefined,
    userId: string,
  ) {
    this.validateFile(file.mimetype, file.size);
    await this.requireWritableFolder(folderId, userId);

    const safeName = this.sanitizeFileName(file.originalname);
    const key = this.r2Service.generateKey(safeName, userId);
    const fileId = new Types.ObjectId().toHexString();

    await this.r2Service.uploadObject(key, file.buffer, file.mimetype);

    this.logger.log(
      `Direct upload | user=${userId} | file=${file.originalname} | size=${file.size}`,
    );

    return {
      key,
      fileId,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      folderId,
    };
  }

  /* =========================
     FOLDER UPLOAD
     Creates the folder hierarchy in DB and returns presigned upload URLs
     for every file mapped to its correct folder.
  ========================= */
  async initiateFolderUpload(
    dto: FolderUploadDto,
    userId: string,
    organizationId?: string | null,
  ) {
    this.validateFolderName(dto.folderName);

    const userObjId = new Types.ObjectId(userId);
    const organizationObjId = organizationId ? new Types.ObjectId(organizationId) : null;

    // ---- 1. Resolve or create root folder ----
    let parentPath = '/';
    let parentId: Types.ObjectId | null = null;

    if (dto.parentFolderId) {
      const parent = await this.requireWritableFolder(dto.parentFolderId, userId);
      if (!parent) throw new BadRequestException('Parent folder not found');
      parentId = parent._id as Types.ObjectId;
      parentPath = `${parent.path}${parent.name}/`;
    }

    const rootFolder = await this.findOrCreateFolder(
      dto.folderName,
      parentId,
      parentPath,
      userObjId,
      organizationObjId,
    );

    const rootFolderId = rootFolder._id as Types.ObjectId;
    const rootPath = `${parentPath}${dto.folderName}/`;

    // ---- 2. Parse subfolder paths from relativePaths ----
    // e.g. "css/main.css" → need subfolder "css"
    const subfolderMap = new Map<string, Types.ObjectId>();
    // '' key = root folder
    subfolderMap.set('', rootFolderId);

    const subfolderPaths = new Set<string>();
    for (const file of dto.files) {
      if (file.relativePath) {
        const parts = file.relativePath.split('/');
        // Each directory segment is a potential subfolder
        if (parts.length > 1) {
          for (let i = 1; i < parts.length; i++) {
            const dirPath = parts.slice(0, i).join('/');
            if (dirPath) subfolderPaths.add(dirPath);
          }
        }
      }
    }

    // ---- 3. Create subfolders (sorted so parents come before children) ----
    const sortedPaths = Array.from(subfolderPaths).sort(
      (a, b) => a.split('/').length - b.split('/').length,
    );

    for (const dirPath of sortedPaths) {
      const segments = dirPath.split('/');
      const folderName = segments[segments.length - 1];
      const parentSegments = segments.slice(0, -1).join('/');
      const parentFolderId = subfolderMap.get(parentSegments) ?? rootFolderId;
      const parentFolderPath = this.buildPath(rootPath, parentSegments);

      const folder = await this.findOrCreateFolder(
        folderName,
        parentFolderId,
        parentFolderPath,
        userObjId,
        organizationObjId,
      );

      subfolderMap.set(dirPath, folder._id as Types.ObjectId);
    }

    // ---- 4. Generate presigned URLs for each file ----
    const fileResults = await this.mapWithConcurrency(
      dto.files,
      this.presignConcurrency,
      async (file) => {
        this.validateFile(file.mimeType, file.fileSize);

        const safeName = this.sanitizeFileName(file.fileName);
        const key = this.r2Service.generateKey(safeName, userId);

        // Determine which folder this file belongs to
        const dirPath = file.relativePath
          ? file.relativePath.split('/').slice(0, -1).join('/')
          : '';

        const folderId = subfolderMap.get(dirPath) ?? rootFolderId;
        const fileId = new Types.ObjectId().toHexString();
        const useMultipart = file.fileSize >= this.multipartThreshold;
        const uploadId = useMultipart
          ? await this.r2Service.createMultipartUpload(key, file.mimeType)
          : null;
        const uploadUrl = useMultipart
          ? null
          : (
              await this.r2Service.generatePresignedUploadUrl(
                key,
                file.mimeType,
                file.fileSize,
              )
            ).uploadUrl;
        const partCount = useMultipart
          ? this.getMultipartPartCount(file.fileSize)
          : 1;
        const session = await this.uploadSessionModel.create({
          userId: userObjId,
          organizationId: organizationObjId,
          folderId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.fileSize,
          storageKey: key,
          uploadId,
          uploadType: useMultipart ? 'multipart' : 'single',
          status: 'uploading',
          partsCount: partCount,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        return {
          fileId,
          fileName: file.fileName,
          relativePath: file.relativePath ?? file.fileName,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
          key,
          uploadUrl,
          uploadId,
          uploadSessionId: session._id.toString(),
          uploadType: useMultipart ? 'multipart' : 'single',
          partSize: useMultipart ? this.multipartPartSize : undefined,
          partCount,
          folderId: folderId.toString(),
          expiresIn: this.r2Service.getPresignedUploadExpiry(),
        };
      },
    );

    this.logger.log(
      `Folder upload initiated | user=${userId} | folder="${dto.folderName}" | files=${dto.files.length}`,
    );

    return {
      rootFolder: {
        id: rootFolderId.toString(),
        name: dto.folderName,
        path: rootPath,
      },
      files: fileResults,
      message: `Upload ${dto.files.length} file(s). When done, save each file's metadata via POST /api/v1/files/batch`,
    };
  }

  /* =========================
     UPLOAD SESSIONS — LIST (user)
  ========================= */
  async getUserSessions(userId: string, dto: GetUploadSessionsDto) {
    const limit = dto.limit ?? 20;
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
    };
    if (dto.status && dto.status !== 'all') {
      filter.status = dto.status;
    }

    const sessions = await this.uploadSessionModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-__v')
      .lean();

    return sessions.map((s) => ({
      id: (s._id as any).toString(),
      fileName: s.fileName,
      mimeType: s.mimeType,
      size: s.size,
      uploadType: s.uploadType,
      status: s.status,
      storageKey: s.storageKey,
      folderId: s.folderId?.toString() ?? null,
      partsCount: s.partsCount,
      completedAt: s.completedAt,
      expiresAt: s.expiresAt,
      createdAt: (s as any).createdAt,
    }));
  }

  /* =========================
     UPLOAD SESSIONS — GET ONE
  ========================= */
  async getSession(sessionId: string, userId: string) {
    if (!Types.ObjectId.isValid(sessionId))
      throw new BadRequestException('Invalid session ID');

    const session = await this.uploadSessionModel
      .findOne({
        _id: new Types.ObjectId(sessionId),
        userId: new Types.ObjectId(userId),
      })
      .select('-__v')
      .lean();

    if (!session) throw new NotFoundException('Upload session not found');

    return {
      id: (session._id as any).toString(),
      fileName: session.fileName,
      mimeType: session.mimeType,
      size: session.size,
      uploadType: session.uploadType,
      status: session.status,
      storageKey: session.storageKey,
      uploadId: session.uploadId,
      folderId: session.folderId?.toString() ?? null,
      partsCount: session.partsCount,
      metadata: session.metadata,
      completedAt: session.completedAt,
      expiresAt: session.expiresAt,
      createdAt: (session as any).createdAt,
    };
  }

  /* =========================
     UPLOAD SESSIONS — CANCEL
  ========================= */
  async cancelSession(sessionId: string, userId: string) {
    if (!Types.ObjectId.isValid(sessionId))
      throw new BadRequestException('Invalid session ID');

    const session = await this.uploadSessionModel.findOne({
      _id: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(userId),
    });

    if (!session) throw new NotFoundException('Upload session not found');

    if (session.status === 'completed') {
      throw new BadRequestException('Cannot cancel a completed upload session');
    }

    /* Abort the multipart upload in R2 if still in progress */
    if (session.uploadType === 'multipart' && session.uploadId) {
      await this.r2Service
        .abortMultipartUpload(session.uploadId, session.storageKey)
        .catch(() => undefined);
    }

    await this.uploadSessionModel.findByIdAndUpdate(session._id, {
      status: 'aborted',
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    this.logger.log(`Session cancelled | user=${userId} | session=${sessionId}`);
    return { message: 'Upload session cancelled' };
  }

  /* =========================
     ADMIN — STATS
  ========================= */
  async getAdminStats() {
    const [total, uploading, completed, failed, aborted, sizeResult] =
      await Promise.all([
        this.uploadSessionModel.countDocuments(),
        this.uploadSessionModel.countDocuments({ status: 'uploading' }),
        this.uploadSessionModel.countDocuments({ status: 'completed' }),
        this.uploadSessionModel.countDocuments({ status: 'failed' }),
        this.uploadSessionModel.countDocuments({ status: 'aborted' }),
        this.uploadSessionModel.aggregate<{ total: number }>([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$size' } } },
        ]),
      ]);

    return {
      total,
      uploading,
      completed,
      failed,
      aborted,
      completedTotalSize: sizeResult[0]?.total ?? 0,
    };
  }

  /* =========================
     PRIVATE: find or create folder
  ========================= */
  private async findOrCreateFolder(
    name: string,
    parentId: Types.ObjectId | null,
    parentPath: string,
    createdBy: Types.ObjectId,
    organizationId: Types.ObjectId | null,
  ): Promise<FolderDocument> {
    const existing = await this.folderModel.findOne({
      name,
      parentId,
      createdBy,
      isDeleted: false,
    });

    if (existing) return existing;

    return this.folderModel.create({
      name,
      parentId,
      path: parentPath,
      createdBy,
      organizationId,
      status: 'active',
      description: '',
    });
  }

  private buildPath(rootPath: string, dirPath: string): string {
    if (!dirPath) return rootPath;
    return `${rootPath}${dirPath}/`;
  }

  private validateFolderName(name: string): void {
    if (!name || !name.trim()) {
      throw new BadRequestException('Folder name cannot be empty');
    }
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      throw new BadRequestException('Folder name contains invalid characters');
    }
    if (name.length > 255) {
      throw new BadRequestException('Folder name is too long (max 255 characters)');
    }
  }
}
