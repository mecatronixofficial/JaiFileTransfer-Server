import { Types } from 'mongoose';
import { FilesService } from './files.service';

describe('expired file cleanup', () => {
  it('advances past failures and reports them for delayed retry', async () => {
    const first = { _id: new Types.ObjectId(), key: 'failed' };
    const second = { _id: new Types.ObjectId(), key: 'ok' };
    const batches = [[first], [second], []];
    const model = {
      find: jest.fn().mockImplementation(() => ({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(batches.shift()),
      })),
      findByIdAndDelete: jest.fn().mockResolvedValue(second),
    };
    const storage = {
      deleteObject: jest
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined),
    };
    const service = new FilesService(
      model as any,
      {} as any,
      {} as any,
      {} as any,
      storage as any,
      {} as any,
    );
    await expect(service.permanentlyDeleteExpired(7)).rejects.toThrow(
      '1 file(s); 1 deleted',
    );
    expect(model.find).toHaveBeenCalledTimes(3);
    expect(model.find.mock.calls[1][0]._id.$gt).toEqual(first._id);
    expect(model.findByIdAndDelete).toHaveBeenCalledTimes(1);
    expect(model.findByIdAndDelete).toHaveBeenCalledWith(second._id);
  });
});
