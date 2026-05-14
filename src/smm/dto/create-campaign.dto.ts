// src/smm/dto/create-campaign.dto.ts
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { SmmSourceMode } from '../entities/smm-campaign.entity';

export class CreateCampaignDto {
  @IsIn(['auto', 'topic', 'trends'])
  sourceMode!: SmmSourceMode;

  @IsInt() @Min(1) @Max(20)
  requestedCount!: number;

  @IsOptional() @IsString() @MaxLength(500)
  topic?: string;

  @IsOptional() @IsUUID()
  conversationId?: string;
}
