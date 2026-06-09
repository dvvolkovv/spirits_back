import { IsEnum, IsOptional, IsString, IsUUID, MinLength, MaxLength } from 'class-validator';

export class CreateBotConfigDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @IsOptional()
  @IsString()
  presetAgentId?: string;

  @IsOptional()
  @IsUUID()
  customAgentId?: string;

  @IsEnum(['strict', 'always', 'smart'])
  addressingMode!: 'strict' | 'always' | 'smart';

  @IsEnum(['never', 'mirror', 'always'])
  voiceReplyMode!: 'never' | 'mirror' | 'always';
}

export class UpdateBotConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  presetAgentId?: string;

  @IsOptional()
  @IsUUID()
  customAgentId?: string;

  @IsOptional()
  @IsEnum(['strict', 'always', 'smart'])
  addressingMode?: 'strict' | 'always' | 'smart';

  @IsOptional()
  @IsEnum(['never', 'mirror', 'always'])
  voiceReplyMode?: 'never' | 'mirror' | 'always';
}
