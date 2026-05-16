// src/smm/social-accounts/social-account.dto.ts
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTelegramAccountDto {
  @IsString() @IsNotEmpty()
  botToken!: string;

  @IsString() @IsNotEmpty()
  chatId!: string;        // "@my_channel" or "-1001234567890"

  @IsString() @IsOptional()
  displayName?: string;
}
