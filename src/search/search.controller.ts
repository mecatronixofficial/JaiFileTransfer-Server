import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search.dto';

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @Query() query: SearchQueryDto,
    @CurrentUser() currentUser: any,
  ) {
    const result = await this.searchService.search(
      query.q,
      currentUser,
      query.page,
      query.limit,
      query.type,
    );

    return { message: 'Search results', data: result };
  }
}
