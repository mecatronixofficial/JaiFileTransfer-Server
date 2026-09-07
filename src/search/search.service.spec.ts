import { SearchService } from './search.service';
import { Types } from 'mongoose';
import { Role } from '../common/enums';

describe('search query budget', () => {
  it('applies timeouts and only queries the requested collection', async () => {
    const makeQuery = (result: unknown) => ({
      select: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(result),
    });
    const find = makeQuery([]),
      count = makeQuery(0);
    const files = {
      find: jest.fn().mockReturnValue(find),
      countDocuments: jest.fn().mockReturnValue(count),
    };
    const unused = { find: jest.fn(), countDocuments: jest.fn() };
    const service = new SearchService(
      files as any,
      unused as any,
      unused as any,
      unused as any,
    );
    const userId = new Types.ObjectId().toString();
    const result = await service.search(
      'a.b',
      { _id: userId, role: Role.USER },
      1,
      20,
      'file',
    );
    expect(result.total).toBe(0);
    expect(unused.find).not.toHaveBeenCalled();
    expect(find.maxTimeMS).toHaveBeenCalledWith(3000);
    expect(count.maxTimeMS).toHaveBeenCalledWith(3000);
    expect(files.find.mock.calls[0][0].$or[0].fileName.$regex).toBe('a\\.b');
    expect(files.find.mock.calls[0][0].$and[0].$or[0].uploadedBy).toBe(userId);
  });
});
