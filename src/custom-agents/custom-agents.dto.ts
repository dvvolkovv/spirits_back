import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';

export class CreateCustomAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsString()
  @MinLength(20)
  @MaxLength(20000)
  systemPrompt!: string;
}

export class UpdateCustomAgentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(20000)
  systemPrompt?: string;
}

export class DraftPromptDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  description!: string;
}
