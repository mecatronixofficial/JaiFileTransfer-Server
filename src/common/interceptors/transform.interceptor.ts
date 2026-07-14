import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T | null;
  meta?: Record<string, unknown>;
  timestamp: string;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const response = context.switchToHttp().getResponse<{ statusCode: number }>();

    return next.handle().pipe(
      map((payload) => {
        const statusCode = response.statusCode;

        // Already-formatted response — pass through unchanged.
        if (payload && typeof payload === 'object' && 'success' in payload) {
          return payload as ApiResponse<T>;
        }

        const p = payload as Record<string, unknown> | null | undefined;
        const message = (p?.message as string | undefined) ?? 'Request successful';
        const data =
          p !== null && p !== undefined && 'data' in p ? p.data : payload;
        const meta = p?.meta as Record<string, unknown> | undefined;

        return {
          success: true,
          statusCode,
          message,
          data: (data ?? null) as T | null,
          ...(meta ? { meta } : {}),
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
