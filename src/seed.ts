/**
 * Jai-India FileTransfer — Database Seeder (Production Ready)
 *
 * Usage:
 *   npx ts-node src/seed.ts
 *   OR
 *   npm run seed
 */

import 'reflect-metadata';
import mongoose, { Schema, Document, Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * 🔐 ENV VALIDATION
 */
const MONGO_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/jai-india-filetransfer';

const SUPERADMIN_EMAIL =
  process.env.SUPERADMIN_EMAIL || 'superadmin@jai-india.com';

const SUPERADMIN_PASSWORD =
  process.env.SUPERADMIN_PASSWORD || 'SuperAdmin@123!';

const SUPERADMIN_NAME = process.env.SUPERADMIN_NAME || 'Super Administrator';

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI is missing in .env');
  process.exit(1);
}

/**
 * 👤 USER INTERFACE
 */
interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: 'superadmin' | 'admin' | 'user';
  isActive: boolean;
  isEmailVerified: boolean;
  createdBy?: mongoose.Types.ObjectId | null;
  lastLoginAt?: Date | null;
  department?: string | null;
  phone?: string | null;
}

/**
 * 🧩 USER SCHEMA
 */
const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true, // ✅ only define here (avoid duplicate index warnings)
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ['superadmin', 'admin', 'user'],
      default: 'user',
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    isEmailVerified: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    lastLoginAt: { type: Date, default: null },
    department: { type: String, default: null },
    phone: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/**
 * ⚠️ Prevent model overwrite in dev
 */
const UserModel: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

/**
 * 🌱 SEED FUNCTION
 */
async function seed() {
  console.log('🌱 Starting database seeder...\n');

  try {
    /**
     * 📡 CONNECT DB
     */
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');

    /**
     * 🔍 CHECK EXISTING SUPERADMIN
     */
    const existing = await UserModel.findOne({
      role: 'superadmin',
    });

    if (existing) {
      console.log('⚠️ SUPERADMIN already exists');
      console.log(`👉 Email: ${existing.email}`);
      console.log(`👉 ID   : ${existing._id}\n`);

      return;
    }

    /**
     * 🔐 HASH PASSWORD
     */
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(SUPERADMIN_PASSWORD, saltRounds);

    /**
     * 👑 CREATE SUPERADMIN
     */
    const superAdmin = await UserModel.create({
      name: SUPERADMIN_NAME,
      email: SUPERADMIN_EMAIL,
      password: hashedPassword,
      role: 'superadmin',
      isActive: true,
      isEmailVerified: true,
    });

    /**
     * 🎉 SUCCESS LOG
     */
    console.log(`
╔════════════════════════════════════════════╗
║   ✅ SUPERADMIN CREATED SUCCESSFULLY       ║
╠════════════════════════════════════════════╣
║  Name     : ${SUPERADMIN_NAME.padEnd(28)}║
║  Email    : ${SUPERADMIN_EMAIL.padEnd(28)}║
║  Password : ${SUPERADMIN_PASSWORD.padEnd(28)}║
║  ID       : ${superAdmin._id.toString().padEnd(28)}║
╠════════════════════════════════════════════╣
║  ⚠️  Change password immediately!          ║
╚════════════════════════════════════════════╝
    `);
  } catch (error) {
    console.error('❌ Seeder failed:', error);
    process.exitCode = 1;
  } finally {
    /**
     * 🔌 DISCONNECT DB
     */
    await mongoose.disconnect();
    console.log('🔌 MongoDB disconnected');
  }
}

/**
 * 🚀 RUN
 */
seed();
