// src/smm/render/render-callback.dto.ts
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class RenderCallbackDto {
  @IsUUID()
  videoId!: string;

  @IsIn(['ready', 'failed', 'escape_hatch_offered'])
  status!: 'ready' | 'failed' | 'escape_hatch_offered';

  @IsOptional() @IsString()
  mp4Url?: string;

  @IsOptional() @IsInt() @Min(1)
  durationSec?: number;

  @IsOptional() @IsInt() @Min(1)
  sizeBytes?: number;

  @IsOptional() @IsString()
  errorMessage?: string;

  @IsOptional() @IsObject()
  escapeHatch?: { sceneIdx: number; message: string };
}

export class RenderStateUpdateDto {
  @IsUUID()
  videoId!: string;

  @IsObject()
  renderState!: Record<string, unknown>;
}
