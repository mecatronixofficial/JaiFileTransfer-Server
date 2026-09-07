import 'reflect-metadata';
import {
  getFileExtension,
  MIME_TYPE_PATTERN,
  normalizeUploadMimeType,
} from './file-type.util';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InitiateMultipartDto, PresignedUrlDto, FolderUploadDto, BatchFileMetaDto } from './dto/upload.dto';
import { SaveFileMetadataDto } from '../files/dto/file.dto';

describe('file type normalization', () => {
  it.each([
    ['archive.rar', 'application/x-rar', 'application/vnd.rar'],
    ['REPORT.XLSM', '', 'application/vnd.ms-excel.sheet.macroenabled.12'],
    ['drawing.dwg', 'application/octet-stream', 'image/vnd.dwg'],
    ['mail.msg', 'application/octet-stream', 'application/vnd.ms-outlook'],
  ])(
    'normalizes %s independently of the client MIME',
    (name, supplied, expected) => {
      expect(normalizeUploadMimeType(name, supplied)).toBe(expected);
    },
  );

  it('keeps a valid MIME type for an unknown company file extension', () => {
    expect(
      normalizeUploadMimeType('ledger.qbw', 'application/x-quickbooks'),
    ).toBe('application/x-quickbooks');
  });

  it('uses a safe binary fallback for missing or malformed MIME values', () => {
    expect(normalizeUploadMimeType('payload.custom')).toBe(
      'application/octet-stream',
    );
    expect(
      normalizeUploadMimeType('payload.custom', 'text/plain\r\nx-test: bad'),
    ).toBe('application/octet-stream');
  });

  it('extracts only a real final extension', () => {
    expect(getFileExtension('folder\\archive.part01.rar')).toBe('rar');
    expect(getFileExtension('.env')).toBe('');
    expect(getFileExtension('README')).toBe('');
  });

  it('accepts concrete MIME values and rejects header parameters and wildcards', () => {
    expect(MIME_TYPE_PATTERN.test('application/vnd.company.asset+zip')).toBe(
      true,
    );
    expect(MIME_TYPE_PATTERN.test('application/*')).toBe(false);
    expect(MIME_TYPE_PATTERN.test('text/plain; charset=utf-8')).toBe(false);
  });

  it('normalizes a browser-specific RAR MIME before DTO validation', async () => {
    const dto = plainToInstance(InitiateMultipartDto, {
      fileName: 'records.rar',
      mimeType: 'application/x-rar',
      fileSize: 8 * 1024 * 1024,
    });

    expect(dto.mimeType).toBe('application/vnd.rar');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts executable MIME values for multipart uploads', async () => {
    const dto = plainToInstance(InitiateMultipartDto, {
      fileName: 'installer.exe',
      mimeType: 'application/vnd.microsoft.portable-executable',
      fileSize: 1024,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['setup.exe', 'script.PS1', 'mobile.apk', 'shortcut.lnk', '.env', 'README'])(
    'accepts %s without a browser MIME type, including empty files',
    async (fileName) => {
      const dto = plainToInstance(PresignedUrlDto, { fileName, fileSize: 0 });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.mimeType).toBe('application/octet-stream');
    },
  );

  it('accepts custom types and zero bytes through folder and metadata validation', async () => {
    const file = {
      fileName: 'ledger.custom', originalName: 'ledger.custom',
      mimeType: 'application/vnd.company.asset', fileSize: 0, size: 0,
      key: 'uploads/user/ledger.custom', relativePath: 'nested/ledger.custom',
    };
    expect(await validate(plainToInstance(FolderUploadDto, {
      folderName: 'Project', files: [file], directories: ['empty/subfolder'],
    }))).toHaveLength(0);
    expect(await validate(plainToInstance(SaveFileMetadataDto, file))).toHaveLength(0);
    expect(await validate(plainToInstance(BatchFileMetaDto, file))).toHaveLength(0);
    expect(await validate(plainToInstance(FolderUploadDto, { folderName: 'Empty' }))).toHaveLength(0);
  });

  it.each([-1, 101 * 1024 ** 3])('rejects invalid file size %s', async (fileSize) => {
    expect(await validate(plainToInstance(PresignedUrlDto, {
      fileName: 'data.bin', fileSize,
    }))).not.toHaveLength(0);
  });
});
