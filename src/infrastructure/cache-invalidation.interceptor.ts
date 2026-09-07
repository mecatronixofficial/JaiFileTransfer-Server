import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { mergeMap } from 'rxjs/operators';
import { StatsCacheService } from './stats-cache.service';

@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly stats: StatsCacheService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const method = context
      .switchToHttp()
      .getRequest<{ method: string }>().method;
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next.handle();
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        await this.stats.invalidate();
        return result;
      }),
    );
  }
}
