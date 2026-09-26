import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ROBOT_BUILDER_ROLES } from '@kora/domain';

import { Roles } from '../auth/decorators';

/** Placeholder for the goal 06 strategy builder. Establishes the RBAC boundary now. */
@ApiTags('robots')
@Controller('robots')
@Roles(...ROBOT_BUILDER_ROLES)
export class RobotsController {
  @Get('builder')
  @ApiOperation({ summary: 'Strategy builder metadata (stub until goal 06). Trader, quant or admin only.' })
  builder() {
    return { blocks: [], status: 'stub_goal_06' };
  }
}
