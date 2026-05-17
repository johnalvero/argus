import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Bootstrap seed.
 *
 * Generates a per-install random password for the admin user, writes it
 * to `prisma/.bootstrap-credentials` with mode 0600, and never logs it
 * to stdout. The file should be deleted after first successful login.
 *
 * Idempotent: existing users with a passwordHash are left untouched.
 */

const prisma = new PrismaClient();

const BOOTSTRAP_EMAIL = "admin@convergeict.com";
const BCRYPT_ROUNDS = 12;
const CREDENTIALS_FILE = path.join(__dirname, ".bootstrap-credentials");

function generatePassword(): string {
  // 24 base64url chars = ~144 bits of entropy. Memorable enough to type once.
  return crypto.randomBytes(18).toString("base64url");
}

function persistCredentials(email: string, password: string) {
  const body = [
    "# Argus bootstrap credentials — DELETE THIS FILE after first login.",
    `# Generated: ${new Date().toISOString()}`,
    `email=${email}`,
    `password=${password}`,
    "",
  ].join("\n");
  fs.writeFileSync(CREDENTIALS_FILE, body, { mode: 0o600 });
  // Re-chmod in case the file already existed with looser perms.
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

async function main() {
  const existing = await prisma.user.findUnique({
    where: { email: BOOTSTRAP_EMAIL },
  });

  if (existing && existing.passwordHash) {
    console.log(
      `Admin user "${BOOTSTRAP_EMAIL}" already has a password set — leaving as-is.`
    );
    return;
  }

  const password = generatePassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  if (!existing) {
    await prisma.user.create({
      data: {
        email: BOOTSTRAP_EMAIL,
        passwordHash: hash,
        isAdmin: true,
        mustChangePassword: true,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: hash, isAdmin: true, mustChangePassword: true },
    });
  }

  persistCredentials(BOOTSTRAP_EMAIL, password);

  console.log(
    `Admin bootstrap created for ${BOOTSTRAP_EMAIL}.\n` +
      `Password written to ${CREDENTIALS_FILE} (mode 0600).\n` +
      `Read it, log in, rotate the password, then DELETE the file.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
