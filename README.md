# 🇮🇳 Jai-India FileTransfer — Enterprise Backend

A production-ready, enterprise-level private file transfer platform built with **NestJS**, **MongoDB**, and **Cloudflare R2**.

---

## 🏗️ Architecture Overview

```
Client
  │
  ├── POST /auth/login           → Validates credentials, sends OTP
  ├── POST /auth/verify-otp      → Verifies OTP, returns JWT
  │
  ├── POST /upload/presigned-url → Gets R2 presigned URL
  │                                Client uploads DIRECTLY to R2 (no backend load)
  ├── POST /files                → Saves file metadata to MongoDB
  │
  └── GET  /files/:id/download   → Gets time-limited presigned download URL
```

---

## 🧱 Tech Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Framework   | NestJS 10 (TypeScript)              |
| Database    | MongoDB 7 + Mongoose 8              |
| Storage     | Cloudflare R2 (S3-compatible)       |
| Auth        | JWT + bcrypt + 2FA OTP              |
| Email       | Nodemailer (SMTP)                   |
| Security    | Helmet, Throttler, class-validator  |
| Scheduling  | @nestjs/schedule (CRON)             |

---

## 📁 Project Structure

```
src/
├── main.ts                         # App bootstrap (Helmet, CORS, pipes)
├── app.module.ts                   # Root module
├── seed.ts                         # DB seeder (creates SUPERADMIN)
│
├── config/
│   └── configuration.ts            # All environment config (typed)
│
├── common/
│   ├── decorators/
│   │   ├── roles.decorator.ts      # @Roles(...) decorator
│   │   ├── current-user.decorator.ts # @CurrentUser() param decorator
│   │   └── client-ip.decorator.ts  # @ClientIp() param decorator
│   ├── guards/
│   │   ├── jwt-auth.guard.ts       # Global JWT guard
│   │   └── roles.guard.ts          # RBAC roles guard
│   ├── filters/
│   │   └── all-exceptions.filter.ts # Global error handler
│   ├── interceptors/
│   │   └── transform.interceptor.ts # Uniform API response shape
│   └── enums/
│       └── index.ts                 # Role, TransactionAction, OtpPurpose
│
├── auth/
│   ├── auth.service.ts             # Login + OTP verification
│   ├── auth.controller.ts          # POST /auth/login, verify-otp, me
│   ├── auth.module.ts
│   ├── dto/auth.dto.ts
│   └── strategies/jwt.strategy.ts  # Passport JWT strategy
│
├── users/
│   ├── users.service.ts            # CRUD + RBAC creation rules
│   ├── users.controller.ts         # POST /users, GET /users, etc.
│   ├── users.module.ts
│   ├── dto/user.dto.ts
│   └── schemas/user.schema.ts
│
├── otp/
│   ├── otp.service.ts              # Generate, send, verify OTP
│   ├── otp.module.ts
│   └── schemas/otp.schema.ts       # TTL index for auto-expiry
│
├── r2/
│   ├── r2.service.ts               # Presigned upload/download URLs, delete
│   └── r2.module.ts
│
├── upload/
│   ├── upload.service.ts           # MIME + size validation, key generation
│   ├── upload.controller.ts        # POST /upload/presigned-url
│   ├── upload.module.ts
│   └── dto/upload.dto.ts
│
├── files/
│   ├── files.service.ts            # Metadata CRUD, soft delete, download URL
│   ├── files.controller.ts         # POST/GET/DELETE /files
│   ├── files.cron.service.ts       # CRON: purge 7-day-old deleted files
│   ├── files.module.ts
│   ├── dto/file.dto.ts
│   └── schemas/file.schema.ts
│
├── folders/
│   ├── folders.service.ts          # Nested folder CRUD
│   ├── folders.controller.ts       # POST/GET/DELETE /folders
│   ├── folders.module.ts
│   ├── dto/folder.dto.ts
│   └── schemas/folder.schema.ts
│
└── transactions/
    ├── transactions.service.ts     # Audit log writer + query
    ├── transactions.controller.ts  # GET /transactions
    ├── transactions.module.ts
    └── schemas/transaction.schema.ts
```

---

## 👥 RBAC — Role-Based Access Control

| Action                  | SUPERADMIN | ADMIN | USER |
|-------------------------|:----------:|:-----:|:----:|
| Create ADMIN            | ✅         | ❌    | ❌   |
| Create USER             | ✅         | ✅    | ❌   |
| View all users          | ✅         | ✅*   | ❌   |
| View all files          | ✅         | ✅*   | ❌   |
| Upload files            | ✅         | ✅    | ✅   |
| Delete any file         | ✅         | ✅    | ❌   |
| Delete own file         | ✅         | ✅    | ✅   |
| View all transactions   | ✅         | ✅    | ❌   |

*ADMIN sees only users/files they created.

---

## 🔐 Authentication Flow (2FA)

```
1. POST /api/v1/auth/login
   Body: { email, password }
   → Validates credentials
   → Sends 6-digit OTP to email
   → Returns: { message, email }

2. POST /api/v1/auth/verify-otp
   Body: { email, otp }
   → Verifies OTP (5 min expiry)
   → Returns: { accessToken, user }

3. Use: Authorization: Bearer <accessToken>
   on all subsequent requests
```

---

## 📤 File Upload Flow (Direct to R2)

```
1. POST /api/v1/upload/presigned-url
   Body: { fileName, mimeType, fileSize, folderId? }
   → Returns: { uploadUrl, key, expiresIn }

2. PUT <uploadUrl>                   ← Direct to Cloudflare R2
   Headers: { Content-Type: <mimeType> }
   Body: <raw file bytes>
   → File stored in R2 (private bucket)

3. POST /api/v1/files
   Body: { fileName, originalName, mimeType, size, key, folderId? }
   → Saves metadata to MongoDB
   → Returns: file record
```

---

## 🗑️ Delete Flow (OTP-Protected)

```
1. POST /api/v1/auth/request-otp
   Body: { email, purpose: "delete_file", fileId }
   → OTP sent to user's email

2. DELETE /api/v1/files/:id
   Body: { otpCode }
   → Soft delete (isDeleted=true, deletedAt=now)

3. CRON (midnight daily)
   → Finds files where deletedAt < 7 days ago
   → Deletes from Cloudflare R2
   → Removes from MongoDB
```

---

## 🌐 API Endpoints

### Auth
```
POST   /api/v1/auth/login           Login (step 1)
POST   /api/v1/auth/verify-otp      Verify OTP, get JWT (step 2)
POST   /api/v1/auth/request-otp     Request OTP for sensitive action
GET    /api/v1/auth/me              Current user info
```

### Users
```
POST   /api/v1/users                Create user (ADMIN/SUPERADMIN)
GET    /api/v1/users                List users (role-filtered)
GET    /api/v1/users/me             Own profile
GET    /api/v1/users/:id            Get user by ID
PATCH  /api/v1/users/:id            Update user
PUT    /api/v1/users/me/password    Change own password
PATCH  /api/v1/users/:id/activate   Activate user
PATCH  /api/v1/users/:id/deactivate Deactivate user
```

### Upload
```
POST   /api/v1/upload/presigned-url  Get presigned upload URL
```

### Files
```
POST   /api/v1/files                 Save file metadata
GET    /api/v1/files                 List files (with pagination)
GET    /api/v1/files/trash           Soft-deleted files
GET    /api/v1/files/:id/download    Get presigned download URL
DELETE /api/v1/files/:id             Soft delete (OTP required)
PATCH  /api/v1/files/:id/restore     Restore from trash
```

### Folders
```
POST   /api/v1/folders               Create folder
GET    /api/v1/folders               List folders
GET    /api/v1/folders/tree          Nested folder tree
GET    /api/v1/folders/:id           Get folder
PUT    /api/v1/folders/:id           Update folder
DELETE /api/v1/folders/:id           Soft delete folder
```

### Transactions
```
GET    /api/v1/transactions          Audit log (role-filtered)
```

---

## ⚡ Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Seed SUPERADMIN
```bash
npx ts-node src/seed.ts
```

### 4. Run in development
```bash
npm run start:dev
```

### 5. Run in production
```bash
npm run build
npm run start:prod
```

---

## 🔒 Security Features

- **Helmet** — HTTP security headers
- **Rate limiting** — Throttler (configurable per-route)
- **bcrypt** — Password hashing (12 salt rounds)
- **JWT** — Stateless authentication (7-day expiry)
- **2FA OTP** — Every login requires email OTP
- **OTP-gated deletes** — File deletion requires OTP confirmation
- **Presigned URLs only** — No direct R2 URLs ever exposed
- **Private R2 bucket** — No public access to files
- **Input validation** — class-validator on all DTOs
- **RBAC** — Role guards on every route
- **Soft delete** — Files recoverable for 7 days

---

## 📊 MongoDB Indexes

| Collection     | Index                              |
|----------------|------------------------------------|
| users          | email (unique), role, isActive     |
| files          | uploadedBy+isDeleted, folderId+isDeleted, key (unique) |
| folders        | createdBy+isDeleted, parentId, path |
| otps           | userId+purpose, expiresAt (TTL)    |
| transactions   | userId+action, fileId, createdAt   |

---

## 🌍 Environment Variables

See `.env.example` for full list. Key variables:

```env
MONGODB_URI=mongodb://localhost:27017/jai-india-filetransfer
JWT_SECRET=your-super-secret-key
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-key-id
R2_SECRET_ACCESS_KEY=your-secret
R2_BUCKET_NAME=jai-india-filetransfer
PRESIGNED_UPLOAD_EXPIRY=21600
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

For browser uploads directly to Cloudflare R2, configure bucket CORS for your
frontend origin. The Nest API CORS setting does not apply to presigned `PUT`
requests sent from the browser to R2.

```json
[
  {
    "AllowedOrigins": ["https://your-frontend-domain.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

---

## 🏭 Production Checklist

- [ ] Set strong `JWT_SECRET` (32+ random chars)
- [ ] Set `APP_ENV=production`
- [ ] Set `FRONTEND_URL` for CORS
- [ ] Use MongoDB Atlas or replica set
- [ ] Configure R2 bucket CORS for your domain
- [ ] Enable R2 bucket versioning
- [ ] Set up log aggregation (e.g. Datadog, Logtail)
- [ ] Configure reverse proxy (Nginx/Caddy)
- [ ] Run behind HTTPS only
- [ ] Change default SUPERADMIN password immediately

---

## 📄 License

Private — Jai-India FileTransfer. All rights reserved.
