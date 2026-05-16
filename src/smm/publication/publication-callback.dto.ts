// src/smm/publication/publication-callback.dto.ts
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class PublicationCallbackDto {
  @IsUUID()
  publicationId!: string;

  @IsIn(['published', 'failed'])
  status!: 'published' | 'failed';

  @IsOptional() @IsString()
  externalUrl?: string;

  @IsOptional() @IsString()
  externalPostId?: string;

  @IsOptional() @IsString()
  errorMessage?: string;
}
