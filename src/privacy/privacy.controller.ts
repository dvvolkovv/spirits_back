import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { PgService } from '../common/services/pg.service';
import {
  PrivacyProfileNotFoundError,
  assertPrivacySettingsPatch,
  getPrivacySettings,
  updatePrivacySettings,
} from './profile-privacy';

@Controller('privacy-settings')
@UseGuards(JwtGuard)
export class PrivacyController {
  constructor(private readonly pg: PgService) {}

  @Get()
  async getSettings(@CurrentUser() user: { userId: string }) {
    try {
      return await getPrivacySettings(this.pg, user.userId);
    } catch (error) {
      this.throwStorageError(error);
    }
  }

  @Post()
  @HttpCode(200)
  async updateSettings(
    @CurrentUser() user: { userId: string },
    @Body() body: unknown,
  ) {
    try {
      assertPrivacySettingsPatch(body);
    } catch {
      throw new BadRequestException({ code: 'INVALID_PRIVACY_SETTINGS' });
    }

    try {
      return await updatePrivacySettings(this.pg, user.userId, body);
    } catch (error) {
      this.throwStorageError(error);
    }
  }

  private throwStorageError(error: unknown): never {
    if (error instanceof PrivacyProfileNotFoundError) {
      throw new NotFoundException({ code: 'PROFILE_NOT_AVAILABLE' });
    }
    throw new ServiceUnavailableException({ code: 'PRIVACY_SETTINGS_UNAVAILABLE' });
  }
}
