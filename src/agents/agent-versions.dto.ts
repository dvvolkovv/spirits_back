import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateAgentDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200000)
  system_prompt!: string;

  @IsUUID()
  base_version_id!: string;
}

export class PublishAgentVersionDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  expected_published_version_id!: string | null;
}

export class TestAgentVersionDto {
  @IsUUID()
  version_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(12000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  session_id?: string;
}
