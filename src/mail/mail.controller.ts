import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

import { MailService } from './mail.service';
import { MailLogType } from './schemas/mail-log.schema';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';

class AdminMailLogsQuery {
  @IsEnum(MailLogType)
  @IsOptional()
  type?: MailLogType;

  @IsOptional()
  status?: string;

  @IsOptional()
  email?: string;
}

@Controller('mail')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SUPERADMIN)
export class MailController {
  constructor(private readonly mailService: MailService) {}

  /** GET /mail/admin/logs — paginated mail log viewer */
  @Get('admin/logs')
  async getLogs(
    @Query() query: AdminMailLogsQuery,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const data = await this.mailService.getAdminLogs({
      page,
      limit,
      type: query.type,
      status: query.status,
      email: query.email,
    });
    return { success: true, message: 'Mail logs retrieved', data };
  }

  /** GET /mail/admin/stats — aggregate stats */
  @Get('admin/stats')
  async getStats() {
    const data = await this.mailService.getAdminStats();
    return { success: true, message: 'Mail stats retrieved', data };
  }
}
