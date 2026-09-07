import { Types } from 'mongoose';
import { UploadService } from './upload.service';

describe('upload manifests', () => {
  const userId = new Types.ObjectId().toHexString();
  let service: UploadService;
  let folders: { findOne: jest.Mock; create: jest.Mock };
  let sessions: { create: jest.Mock };
  let r2: Record<string, jest.Mock>;

  beforeEach(() => {
    folders = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (data) => ({ ...data, _id: new Types.ObjectId() })),
    };
    sessions = { create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }) };
    r2 = {
      generateKey: jest.fn((name: string) => `uploads/${userId}/${name}`),
      generatePresignedUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://storage.test/upload' }),
      createMultipartUpload: jest.fn().mockResolvedValue('multipart-id'),
      getPresignedUploadExpiry: jest.fn().mockReturnValue(3600),
    };
    service = new UploadService(r2 as any, folders as any, sessions as any);
  });

  it.each([
    ['setup.exe', 'application/vnd.microsoft.portable-executable', 10],
    ['data.custom', 'application/x-company-data', 0],
  ])('presigns %s with its content type and size', async (fileName, mimeType, fileSize) => {
    await service.generatePresignedUrl({ fileName, mimeType, fileSize }, userId);
    expect(r2.generatePresignedUploadUrl).toHaveBeenCalledWith(
      expect.any(String), mimeType, fileSize,
    );
  });

  it('creates nested and empty folders and assigns each file to its directory', async () => {
    const result = await service.initiateFolderUpload({
      folderName: 'Project', directories: ['empty/deeper'],
      files: [
        { fileName: 'setup.exe', mimeType: '', fileSize: 0, relativePath: 'tools\\setup.exe' },
        { fileName: 'data.custom', mimeType: 'application/x-company', fileSize: 120 * 1024 ** 2, relativePath: 'data.custom' },
      ],
    }, userId);
    expect(folders.create.mock.calls.map(([folder]) => folder.name)).toEqual([
      'Project', 'empty', 'tools', 'deeper',
    ]);
    const toolsFolder = await folders.create.mock.results[2].value;
    expect(result.files[0]).toMatchObject({
      relativePath: 'tools/setup.exe', fileSize: 0, mimeType: 'application/octet-stream',
      folderId: toolsFolder._id.toString(), uploadType: 'single',
    });
    expect(result.files[1]).toMatchObject({
      folderId: result.rootFolder.id, uploadType: 'multipart', partCount: 3,
    });
    expect(sessions.create).toHaveBeenCalledTimes(2);
  });

  it('creates a completely empty root without any storage uploads', async () => {
    const result = await service.initiateFolderUpload({ folderName: 'Empty', files: [] }, userId);
    expect(result.files).toEqual([]);
    expect(folders.create).toHaveBeenCalledTimes(1);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(r2.generatePresignedUploadUrl).not.toHaveBeenCalled();
  });

  it.each(['../outside', '/absolute', 'C:\\outside', 'a//b', 'a/./b', 'a/\u0000b'])(
    'rejects directory %s before any writes', async (path) => {
      await expect(service.initiateFolderUpload({
        folderName: 'Project', files: [], directories: [path],
      }, userId)).rejects.toThrow();
      expect(folders.create).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a file/directory collision before writes', async () => {
    await expect(service.initiateFolderUpload({
      folderName: 'Project', directories: ['item/child'],
      files: [{ fileName: 'item', mimeType: '', fileSize: 0 }],
    }, userId)).rejects.toThrow('both a file and a directory');
    expect(folders.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate paths before writes', async () => {
    const file = { fileName: 'item', mimeType: '', fileSize: 0 };
    await expect(service.initiateFolderUpload({
      folderName: 'Project', files: [file, file],
    }, userId)).rejects.toThrow('Duplicate file paths');
    expect(folders.create).not.toHaveBeenCalled();
  });

  it('rejects oversized files before creating their folder', async () => {
    await expect(service.initiateFolderUpload({
      folderName: 'Project', files: [{ fileName: 'data', mimeType: '', fileSize: 101 * 1024 ** 3 }],
    }, userId)).rejects.toThrow('maximum allowed size');
    expect(folders.create).not.toHaveBeenCalled();
  });
});
