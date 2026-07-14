import { IsArray, IsMongoId, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class BulkMarkReadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  ids: string[];
}
