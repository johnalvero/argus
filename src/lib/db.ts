import { PrismaClient } from "@prisma/client";

// Prevent hot-reload from spawning multiple PrismaClient instances in dev.
declare global {
  // eslint-disable-next-line no-var
  var _prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global._prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global._prisma = prisma;
}
