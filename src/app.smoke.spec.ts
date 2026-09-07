import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import cookieParser from 'cookie-parser';
import { UsersService } from './users/users.service';
import { FilesService } from './files/files.service';
import { UploadService } from './upload/upload.service';
import { SharesService } from './shares/shares.service';
import { AuthService } from './auth/auth.service';
import { SmtpService } from './mail/smtp.service';
import { R2Service } from './r2/r2.service';
import { Role, ShareType, ResourceType } from './common/enums';

describe('Nest 11 API migration', () => {
  let app: INestApplication;
  let base: string;
  let token: string;
  const user = {
    _id: new Types.ObjectId(),
    email: 'test@example.test',
    role: Role.USER,
    isActive: true,
    tokenVersion: 0,
  };
  const fileId = new Types.ObjectId().toString();

  beforeAll(async () => {
    // Synthetic configuration; external providers below are replaced before init.
    Object.assign(process.env, {
      JWT_SECRET: 'smoke-test-secret',
      JWT_ACCESS_SECRET: 'smoke-access',
      JWT_REFRESH_SECRET: 'smoke-refresh',
      R2_ACCOUNT_ID: 'test',
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      SMTP_HOST: 'localhost',
      SMTP_USER: 'test',
      SMTP_PASSWORD: 'test',
      CACHE_REDIS_URL: '',
      LOG_LEVEL: 'silent',
    });
    const { AppModule } = await import('./app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(getConnectionToken())
      .useValue({
        models: {},
        model: jest.fn(() => function Model() {}),
        close: jest.fn(),
      })
      .overrideProvider(SmtpService)
      .useValue({ sendMail: jest.fn() })
      .overrideProvider(R2Service)
      .useValue({})
      .compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    jest
      .spyOn(app.get(UsersService), 'findAuthUserById')
      .mockResolvedValue(user as any);
    jest
      .spyOn(app.get(FilesService), 'findAll')
      .mockResolvedValue({ files: [], total: 0 } as any);
    jest
      .spyOn(app.get(FilesService), 'findOneWithDownloadUrl')
      .mockResolvedValue({ downloadUrl: 'https://storage.test/file' } as any);
    jest
      .spyOn(app.get(FilesService), 'softDelete')
      .mockResolvedValue({ message: 'Deleted' } as any);
    jest
      .spyOn(app.get(FilesService), 'saveMetadata')
      .mockImplementation(async (dto) => ({ ...dto, _id: fileId }) as any);
    jest
      .spyOn(app.get(UploadService), 'generatePresignedUrl')
      .mockResolvedValue({
        url: 'https://storage.test/upload',
        mimeType: 'application/octet-stream',
      } as any);
    jest
      .spyOn(app.get(SharesService), 'create')
      .mockResolvedValue({ id: 'share-id' } as any);
    jest
      .spyOn(app.get(AuthService), 'login')
      .mockResolvedValue({ requiresTwoFactor: true } as any);
    token = await app
      .get(JwtService)
      .signAsync({
        sub: user._id.toString(),
        email: user.email,
        role: user.role,
        tokenVersion: 0,
      });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
  });

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = false,
  ) {
    return fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie
          ? { Cookie: `access_token=${token}` }
          : { Authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('keeps public login and rejects unauthenticated private requests', async () => {
    expect((await fetch(`${base}/api/v1/files`)).status).toBe(401);
    expect(
      (
        await request('/auth/login', 'POST', {
          email: user.email,
          password: 'Test-password1!',
        })
      ).status,
    ).toBe(200);
  });

  it('accepts both bearer and cookie JWTs, with role checks intact', async () => {
    expect((await request('/files')).status).toBe(200);
    expect((await request('/files', 'GET', undefined, true)).status).toBe(200);
    expect((await request('/files/admin/stats')).status).toBe(403);
  });

  it('retains upload and metadata validation for custom and empty files', async () => {
    expect(
      (
        await request('/upload/presigned-url', 'POST', {
          fileName: 'app.exe',
          fileSize: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request('/upload/presigned-url', 'POST', {
          fileName: 'app.exe',
          fileSize: -1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/files', 'POST', {
          originalName: 'data.custom',
          mimeType: 'application/x-custom',
          size: 0,
          key: `uploads/${user._id}/data.custom`,
        })
      ).status,
    ).toBe(201);
  });

  it('retains download, sharing, and delete routes', async () => {
    expect((await request(`/files/${fileId}/download`)).status).toBe(200);
    expect(
      (
        await request('/shares', 'POST', {
          type: ShareType.LINK,
          resourceType: ResourceType.FILE,
          fileId,
        })
      ).status,
    ).toBe(201);
    expect((await request(`/files/${fileId}`, 'DELETE')).status).toBe(200);
  });
});
