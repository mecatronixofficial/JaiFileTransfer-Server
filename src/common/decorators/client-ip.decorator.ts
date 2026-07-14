import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Record<string, any>>();
    return (
      (request.headers['cf-connecting-ip'] as string | undefined) ||
      (request.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ||
      (request.headers['x-real-ip'] as string | undefined) ||
      (request.socket?.remoteAddress as string | undefined) ||
      (request.ip as string | undefined) ||
      'unknown'
    );
  },
);
