/**
 * @summary prisma.ts
 * @description Singleton instance of PrismaClient.
 */

import { PrismaClient } from "@prisma/client";

// do this for avoid multiple instances caused by Hot Module Reloading (HMR).
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * @description A singleton instance of PrismaClient.
 */
const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ["query"] });

if (process.env.NODE_ENV !== "prod") globalForPrisma.prisma = prisma;

export default prisma;
