import { Controller, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CustomAgentsService } from './custom-agents.service';

@Controller('')
@UseGuards(JwtGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class CustomAgentsController {
  constructor(private readonly agents: CustomAgentsService) {}
}
