import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      _id: string;
      email: string;
      role: string;
      isActive: boolean;
      tokenVersion: number;
      organizationId: string | null;
    };
    csrfToken?: () => string;
  }
}
