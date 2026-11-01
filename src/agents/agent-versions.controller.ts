import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AgentVersionsService } from './agent-versions.service';

@Controller('admin/agents')
@UseGuards(JwtGuard, AdminGuard)
export class AgentVersionsController {
  constructor(private readonly versions: AgentVersionsService) {}

  @Get(':id/state')
  getState(@Param('id', ParseIntPipe) id: number) {
    return this.versions.getState(id);
  }

  @Get(':id/versions')
  listVersions(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
  ) {
    return this.versions.listVersions(id, Number(limit) || 50);
  }

  @Get(':id/versions/:versionId')
  getVersion(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.getVersion(id, versionId);
  }

  @Post(':id/drafts')
  createDraft(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.versions.createDraft(user.userId, id, body);
  }

  @Post(':id/versions/:versionId/publish')
  publish(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId') versionId: string,
    @Body() body: any,
  ) {
    return this.versions.publish(
      user.userId,
      id,
      versionId,
      body.expected_published_version_id,
    );
  }

  @Post(':id/test')
  test(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.versions.testVersion(
      user.userId,
      id,
      body.version_id,
      body.message,
      body.session_id,
    );
  }
}
