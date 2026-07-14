export const STORAGE_CATEGORY_KEYS = [
  'images',
  'documents',
  'pdfs',
  'spreadsheets',
  'videos',
  'other',
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORY_KEYS)[number];

export interface RawStorageCategoryStat {
  _id: StorageCategory;
  count: number;
  totalSize: number;
  avgSize?: number;
  maxSize?: number;
}

export interface StorageCategoryStat {
  category: StorageCategory;
  count: number;
  totalSizeBytes: number;
  totalSizeMB: number;
  totalSizeGB: number;
  usagePercent: number;
  avgFileSizeBytes: number;
  largestFileSizeBytes: number;
}

export function storageCategoryExpression(
  mimeField = '$mimeType',
): Record<string, unknown> {
  const mime = { $toLower: { $ifNull: [mimeField, ''] } };

  return {
    $switch: {
      branches: [
        { case: { $regexMatch: { input: mime, regex: /^image\// } }, then: 'images' },
        { case: { $regexMatch: { input: mime, regex: /^video\// } }, then: 'videos' },
        { case: { $eq: [mime, 'application/pdf'] }, then: 'pdfs' },
        {
          case: {
            $regexMatch: {
              input: mime,
              regex: /(spreadsheet|excel|csv)/,
            },
          },
          then: 'spreadsheets',
        },
        {
          case: {
            $regexMatch: {
              input: mime,
              regex: /(word|document|opendocument\.text|rtf|text\/plain|presentation|powerpoint)/,
            },
          },
          then: 'documents',
        },
      ],
      default: 'other',
    },
  };
}

export function buildStorageCategoryStats(
  rawStats: RawStorageCategoryStat[],
  totalBytes: number,
): StorageCategoryStat[] {
  const byCategory = new Map(rawStats.map((item) => [item._id, item]));

  return STORAGE_CATEGORY_KEYS.map((category) => {
    const item = byCategory.get(category);
    const totalSizeBytes = item?.totalSize ?? 0;

    return {
      category,
      count: item?.count ?? 0,
      totalSizeBytes,
      totalSizeMB: +(totalSizeBytes / 1024 ** 2).toFixed(2),
      totalSizeGB: +(totalSizeBytes / 1024 ** 3).toFixed(4),
      usagePercent:
        totalBytes > 0 ? +((totalSizeBytes / totalBytes) * 100).toFixed(2) : 0,
      avgFileSizeBytes: Math.round(item?.avgSize ?? 0),
      largestFileSizeBytes: item?.maxSize ?? 0,
    };
  });
}
