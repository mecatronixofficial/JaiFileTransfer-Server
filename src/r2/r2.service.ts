import type { Readable } from 'stream';
import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { MAX_FILE_SIZE } from '../upload/dto/upload.dto';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client;
  private readonly bucketName: string;
  private readonly presignedUploadExpiry: number;
  private readonly presignedDownloadExpiry: number;
  private readonly maxFileSize: number;

  constructor(private readonly configService: ConfigService) {
    const accountId = this.configService.get<string>('r2.accountId');
    const accessKeyId = this.configService.get<string>('r2.accessKeyId');
    const secretAccessKey = this.configService.get<string>('r2.secretAccessKey');
    const endpointFromEnv = this.configService.get<string>('r2.endpoint');
    const bucket = this.configService.get<string>('r2.bucketName');

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('R2 configuration is incomplete');
    }

    this.bucketName = bucket;
    this.presignedUploadExpiry =
      this.configService.get<number>('r2.presignedUploadExpiry') ?? 3600;
    this.presignedDownloadExpiry =
      this.configService.get<number>('r2.presignedDownloadExpiry') ?? 900;
    this.maxFileSize =
      this.configService.get<number>('r2.maxFileSize') ?? MAX_FILE_SIZE;

    const endpoint =
      endpointFromEnv ?? `https://${accountId}.r2.cloudflarestorage.com`;

    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  getPresignedUploadExpiry(): number {
    return this.presignedUploadExpiry;
  }

  /* =========================
     KEY GENERATION
  ========================= */
  generateKey(fileName: string, userId: string): string {
    const lastDot = fileName.lastIndexOf('.');
    // lastDot > 0 excludes dotfiles (.gitignore); lastDot < length-1 excludes trailing dots
    const ext =
      lastDot > 0 && lastDot < fileName.length - 1
        ? fileName.slice(lastDot + 1).toLowerCase()
        : 'bin';
    return `uploads/${userId}/${Date.now()}-${uuidv4()}.${ext}`;
  }

  /* =========================
     PRESIGNED UPLOAD (single)
  ========================= */
  async generatePresignedUploadUrl(key: string, mimeType: string, fileSize: number) {
    if (fileSize > this.maxFileSize) {
      throw new BadRequestException(
        `File size ${fileSize} exceeds the ${this.maxFileSize}-byte limit`,
      );
    }

    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ContentType: mimeType,
          ContentLength: fileSize,
        }),
        { expiresIn: this.presignedUploadExpiry },
      );

      return { uploadUrl: url, key };
    } catch (error) {
      this.logger.error(`Presigned upload URL failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to generate upload URL');
    }
  }

  /* =========================
     PRESIGNED DOWNLOAD
  ========================= */
  async generatePresignedDownloadUrl(key: string, fileName?: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ResponseContentDisposition: fileName
            ? `attachment; filename="${encodeURIComponent(fileName)}"`
            : undefined,
        }),
        { expiresIn: this.presignedDownloadExpiry },
      );
    } catch (error) {
      this.logger.error(`Presigned download URL failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to generate download URL');
    }
  }

  /* =========================
     PRESIGNED INLINE VIEW
  ========================= */
  async generatePresignedViewUrl(key: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: this.presignedDownloadExpiry },
      );
    } catch (error) {
      this.logger.error(`Presigned view URL failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to generate view URL');
    }
  }

  /* =========================
     DIRECT UPLOAD (server-side)
  ========================= */
  async uploadObject(key: string, body: Buffer, mimeType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    } catch (error) {
      this.logger.error(`Direct upload failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to upload file');
    }
  }

  /* =========================
     DELETE
  ========================= */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch (error) {
      this.logger.error(`Delete failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to delete object');
    }
  }

  /* =========================
     COPY (server-side, no re-upload needed)
  ========================= */
  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${sourceKey}`,
          Key: destinationKey,
        }),
      );
    } catch (error) {
      this.logger.error(`Copy failed: ${sourceKey} → ${destinationKey} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to copy object');
    }
  }

  /* =========================
     STREAM (for server-side ZIP)
  ========================= */
  async getObjectStream(key: string): Promise<Readable> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );

      if (!response.Body) {
        throw new NotFoundException(`Object not found: ${key}`);
      }

      return response.Body as unknown as Readable;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Stream failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to stream object');
    }
  }

  /* =========================
     EXISTS
  ========================= */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /* =========================
     METADATA
  ========================= */
  async getObjectMetadata(
    key: string,
  ): Promise<{ size: number; contentType: string } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  /* =========================
     MULTIPART — INIT
  ========================= */
  async createMultipartUpload(key: string, mimeType: string): Promise<string> {
    try {
      const res = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: key,
          ContentType: mimeType,
        }),
      );

      if (!res.UploadId) {
        throw new InternalServerErrorException('Multipart upload init returned no UploadId');
      }

      return res.UploadId;
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      this.logger.error(`Multipart init failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to initialize multipart upload');
    }
  }

  /* =========================
     MULTIPART — PRESIGNED PART URL
  ========================= */
  async generatePresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    if (partNumber < 1 || partNumber > 10000) {
      throw new BadRequestException('Part number must be between 1 and 10000');
    }

    try {
      return await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.presignedUploadExpiry },
      );
    } catch (error) {
      this.logger.error(`Part URL failed: ${key}#${partNumber} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to generate part upload URL');
    }
  }

  /* =========================
     MULTIPART — SERVER-SIDE PART UPLOAD
     Used as a fallback when browser-to-R2 PUT is blocked by CORS/network.
  ========================= */
  async uploadMultipartPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    if (partNumber < 1 || partNumber > 10000) {
      throw new BadRequestException('Part number must be between 1 and 10000');
    }
    if (!body?.length) {
      throw new BadRequestException('Part body cannot be empty');
    }

    try {
      const res = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
        }),
      );

      if (!res.ETag) {
        throw new InternalServerErrorException('R2 did not return an ETag for this part');
      }

      return res.ETag.replace(/^"|"$/g, '');
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error;
      }
      this.logger.error(`Server part upload failed: ${key}#${partNumber} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to upload multipart part');
    }
  }

  /* =========================
     MULTIPART — COMPLETE
  ========================= */
  async completeMultipartUpload(
    uploadId: string,
    key: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            // S3/R2 requires parts in ascending order
            Parts: parts
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    } catch (error) {
      this.logger.error(`Complete multipart failed: ${key} — ${(error as Error).message}`);
      throw new InternalServerErrorException('Failed to complete multipart upload');
    }
  }

  /* =========================
     MULTIPART — ABORT
  ========================= */
  async abortMultipartUpload(uploadId: string, key: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucketName,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Abort multipart failed: ${key} — ${(error as Error).message}`,
      );
    }
  }
}
