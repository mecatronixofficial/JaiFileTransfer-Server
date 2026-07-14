import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';

import { TransactionsService } from './transactions.service';
import { TransactionQueryDto } from './dto/transaction.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('transactions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  async findAll(@CurrentUser() user: any, @Query() query: TransactionQueryDto) {
    const data = await this.transactionsService.findAll(user, query);
    return {
      success: true,
      message: 'Transactions retrieved successfully',
      data,
    };
  }

  @Get('user/:userId')
  async findByUser(
    @Param('userId') userId: string,
    @CurrentUser() user: any,
    @Query() query: TransactionQueryDto,
  ) {
    this.requireValidId(userId, 'user');
    const data = await this.transactionsService.findAll(user, {
      ...query,
      userId,
    });
    return {
      success: true,
      message: 'User transactions retrieved successfully',
      data,
    };
  }

  @Get('file/:fileId')
  async findByFile(
    @Param('fileId') fileId: string,
    @CurrentUser() user: any,
    @Query() query: TransactionQueryDto,
  ) {
    this.requireValidId(fileId, 'file');
    const data = await this.transactionsService.findAll(user, {
      ...query,
      fileId,
    });
    return {
      success: true,
      message: 'File transactions retrieved successfully',
      data,
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.transactionsService.findOne(user, id);
    return {
      success: true,
      message: 'Transaction retrieved successfully',
      data,
    };
  }

  private requireValidId(id: string, label: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label} ID`);
    }
  }
}
