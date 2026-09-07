import { Types } from 'mongoose';
import { FoldersService } from './folders.service';
import { Role } from '../common/enums';

describe('folder contents query count', () => {
  it.each([Role.USER, Role.SUPERADMIN])(
    'groups child counts while preserving %s access filters',
    async (role) => {
      const userId = new Types.ObjectId();
      const folderId = new Types.ObjectId();
      const children = Array.from({ length: 100 }, (_, i) => ({
        _id: new Types.ObjectId(),
        name: `folder-${i}`,
      }));
      const chain = (value: unknown) => ({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(value),
      });
      const folderModel = {
        find: jest.fn().mockReturnValue(chain(children)),
        aggregate: jest
          .fn()
          .mockResolvedValue([{ _id: children[0]._id, count: 3 }]),
        countDocuments: jest.fn(),
      };
      const fileModel = {
        find: jest.fn().mockReturnValue(chain([])),
        aggregate: jest
          .fn()
          .mockResolvedValue([{ _id: children[0]._id, count: 2 }]),
        countDocuments: jest.fn().mockResolvedValue(2),
      };
      const service = new FoldersService(folderModel as any, fileModel as any);
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue({ _id: folderId } as any);
      jest.spyOn(service as any, 'buildBreadcrumb').mockResolvedValue([]);
      jest.spyOn(service as any, 'getDescendantIds').mockResolvedValue([]);
      const result = await service.getContents(folderId.toString(), {
        _id: userId.toString(),
        role,
      });
      expect(folderModel.aggregate).toHaveBeenCalledTimes(1);
      expect(fileModel.aggregate).toHaveBeenCalledTimes(1);
      expect(folderModel.countDocuments).not.toHaveBeenCalled();
      expect(fileModel.countDocuments).toHaveBeenCalledTimes(1); // total descendants only
      const match = fileModel.aggregate.mock.calls[0][0][0].$match;
      expect(match.folderId.$in).toHaveLength(100);
      expect(match.isDeleted).toBe(false);
      expect(match.uploadedBy?.toString()).toBe(
        role === Role.USER ? userId.toString() : undefined,
      );
      expect(result.subfolders[0]).toMatchObject({
        fileCount: 2,
        subfolderCount: 3,
        hasChildren: true,
      });
      expect(result.subfolders[1]).toMatchObject({
        fileCount: 0,
        subfolderCount: 0,
        hasChildren: false,
      });
    },
  );
});
