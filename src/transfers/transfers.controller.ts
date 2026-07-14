import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';

import { TransfersService } from './transfers.service';
import { SendTransferDto, ListTransfersDto } from './dto/transfer.dto';
import { JwtAuthGuard, Public } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClientIp } from '../common/decorators/client-ip.decorator';
import { Role } from '../common/enums';

@Controller('transfers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TransfersController {
  private readonly transferUrlBase: string;

  constructor(
    private readonly transfersService: TransfersService,
    private readonly configService: ConfigService,
  ) {
    this.transferUrlBase = (
      this.configService.get<string>('app.transferUrlBase') ??
      this.configService.get<string>('app.frontendUrl') ??
      'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private currentUserId(user: any): string {
    const userId = user?._id?.toString?.() ?? user?._id ?? user?.id;

    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid authenticated user');
    }

    return userId;
  }

  /* ── Public view (no auth) ── */
  @Public()
  @Get('t/:shortCode')
  async publicView(
    @Param('shortCode') shortCode: string,
    @Query('password') password: string | undefined,
    @ClientIp() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (this.isBrowserNavigation(req)) {
      res.redirect(HttpStatus.FOUND, `${this.transferUrlBase}/t/${shortCode}`);
      return;
    }

    const data = await this.transfersService.publicView(
      shortCode,
      this.parseViewerInfo(req, ip),
      password,
    );
    return { success: true, message: 'Transfer retrieved', data };
  }

  /* ── Download files as ZIP (no auth, folder structure preserved) ──
       Optional ?folder=FolderName filters to a single folder subtree.  ── */
  @Public()
  @Get('t/:shortCode/download')
  async downloadAllZip(
    @Param('shortCode') shortCode: string,
    @Query('password') password: string | undefined,
    @Query('folder') folder: string | undefined,
    @ClientIp() ip: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.transfersService.streamAllAsZip(
      shortCode,
      password,
      this.parseViewerInfo(req, ip),
      res,
      folder,
    );
  }

  /* ── Public file download (no auth, password checked in service) ── */
  @Public()
  @Get('t/:shortCode/files/:fileId/download')
  async publicDownload(
    @Param('shortCode') shortCode: string,
    @Param('fileId') fileId: string,
    @Query('password') password: string | undefined,
    @ClientIp() ip: string,
    @Req() req: Request,
  ) {
    const data = await this.transfersService.publicDownloadFile(
      shortCode,
      fileId,
      password,
      this.parseViewerInfo(req, ip),
    );
    return { success: true, message: 'Download URL generated', data };
  }

  private parseViewerInfo(req: Request, ip: string) {
    const ua = (req.headers['user-agent'] as string) ?? '';
    return {
      ip,
      device: /mobile|android|iphone|ipad/i.test(ua) ? 'Mobile' : 'Desktop',
      browser: /edg\//i.test(ua)
        ? 'Edge'
        : /opr\//i.test(ua)
          ? 'Opera'
          : /chrome/i.test(ua)
            ? 'Chrome'
            : /safari/i.test(ua)
              ? 'Safari'
              : /firefox/i.test(ua)
                ? 'Firefox'
                : 'Unknown',
      os: /windows/i.test(ua)
        ? 'Windows'
        : /mac os/i.test(ua)
          ? 'macOS'
          : /android/i.test(ua)
            ? 'Android'
            : /ios|iphone|ipad/i.test(ua)
              ? 'iOS'
              : /linux/i.test(ua)
                ? 'Linux'
                : 'Unknown',
      location:
        (req.headers['cf-ipcountry'] as string) ??
        (req.headers['x-country'] as string) ??
        'Unknown',
    };
  }

  private isBrowserNavigation(req: Request) {
    const accept = req.headers.accept ?? '';
    return accept.includes('text/html') && !accept.includes('application/json');
  }

  /* ── Send ── */
  @Post('send')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Body() dto: SendTransferDto,
    @CurrentUser() user: any,
    @ClientIp() ip: string,
  ) {
    const result = await this.transfersService.send(
      dto,
      this.currentUserId(user),
      user.name ?? user.email,
      user.organizationId?.toString?.() ?? null,
    );

    return {
      success: true,
      message: 'Transfer sent successfully',
      data: result,
    };
  }

  /* ── List (sent) ── */
  @Get()
  async findAll(@Query() dto: ListTransfersDto, @CurrentUser() user: any) {
    const result = await this.transfersService.findAll(
      this.currentUserId(user),
      user.email,
      dto,
    );
    return { success: true, message: 'Transfers retrieved', data: result };
  }

  /* ── Stats ── */
  @Get('stats')
  async getStats(@CurrentUser() user: any) {
    const data = await this.transfersService.getStats(
      this.currentUserId(user),
      user.email,
    );
    return { success: true, message: 'Stats retrieved', data };
  }

  /* ── Received ── */
  @Get('received')
  async getReceived(@Query() dto: ListTransfersDto, @CurrentUser() user: any) {
    const result = await this.transfersService.getReceived(
      this.currentUserId(user),
      user.email,
      dto,
    );
    return {
      success: true,
      message: 'Received transfers retrieved',
      data: result,
    };
  }

  /* ── Starred ── */
  @Get('starred')
  async getStarred(@Query() dto: ListTransfersDto, @CurrentUser() user: any) {
    const result = await this.transfersService.getStarred(
      this.currentUserId(user),
      user.email,
      dto,
    );
    return {
      success: true,
      message: 'Starred transfers retrieved',
      data: result,
    };
  }

  /* ── Admin — must be declared before /:id to prevent NestJS matching "admin" as an ID ── */

  @Get('admin/all')
  @Roles(Role.SUPERADMIN)
  async getAdminAll(@Query() dto: ListTransfersDto) {
    const result = await this.transfersService.getAdminAll(dto);
    return { success: true, message: 'All transfers retrieved', data: result };
  }

  @Get('admin/stats')
  @Roles(Role.SUPERADMIN)
  async getAdminStats() {
    const data = await this.transfersService.getAdminStats();
    return { success: true, message: 'Admin transfer stats retrieved', data };
  }

  /* ── Detail ── */
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.transfersService.findById(
      id,
      this.currentUserId(user),
      user.email,
    );
    return { success: true, message: 'Transfer retrieved', data };
  }

  /* ── Disable link ── */
  @Patch(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(@Param('id') id: string, @CurrentUser() user: any) {
    await this.transfersService.disable(id, this.currentUserId(user));
    return { success: true, message: 'Transfer disabled' };
  }

  /* ── Re-enable link ── */
  @Patch(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(@Param('id') id: string, @CurrentUser() user: any) {
    await this.transfersService.enable(id, this.currentUserId(user));
    return { success: true, message: 'Transfer re-enabled' };
  }

  /* ── Extend expiry ── */
  @Patch(':id/extend')
  @HttpCode(HttpStatus.OK)
  async extend(
    @Param('id') id: string,
    @Query('days') daysStr: string | undefined,
    @CurrentUser() user: any,
  ) {
    const days = daysStr ? parseInt(daysStr, 10) : 7;
    const data = await this.transfersService.extend(id, this.currentUserId(user), days);
    return { success: true, message: `Expiry extended by ${days} days`, data };
  }

  /* ── Star ── */
  @Post(':id/star')
  @HttpCode(HttpStatus.OK)
  async star(@Param('id') id: string, @CurrentUser() user: any) {
    await this.transfersService.star(id, this.currentUserId(user));
    return { success: true, message: 'Transfer starred' };
  }

  /* ── Unstar ── */
  @Delete(':id/star')
  @HttpCode(HttpStatus.OK)
  async unstar(@Param('id') id: string, @CurrentUser() user: any) {
    await this.transfersService.unstar(id, this.currentUserId(user));
    return { success: true, message: 'Transfer unstarred' };
  }

  /* ── Delete ── */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id') id: string, @CurrentUser() user: any) {
    await this.transfersService.delete(id, this.currentUserId(user));
    return { success: true, message: 'Transfer deleted' };
  }
}
