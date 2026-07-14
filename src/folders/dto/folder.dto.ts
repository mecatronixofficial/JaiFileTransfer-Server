import {
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/* =========================
   CREATE FOLDER
========================= */
export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsMongoId()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a valid hex colour, e.g. #ff6b00' })
  color?: string;
}

/* =========================
   UPDATE FOLDER
========================= */
export class UpdateFolderDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must be a valid hex colour, e.g. #ff6b00' })
  color?: string;
}

/* =========================
   MOVE FOLDER
========================= */
export class MoveFolderDto {
  /** null = move to root; valid ObjectId = move under another folder */
  @IsMongoId()
  @IsOptional()
  parentId?: string | null;
}

/* =========================
   LIST FOLDERS QUERY
========================= */
export class ListFoldersDto {
  @IsOptional()
  @IsMongoId()
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}
