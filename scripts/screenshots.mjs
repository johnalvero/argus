// One-shot screenshot capture for the README.
// Run while `npm run dev` is up: `node scripts/screenshots.mjs`.
//
// Reads bootstrap credentials from prisma/.bootstrap-credentials, logs
// in, rotates the password to itself if mustChangePassword is set, then
// captures each page at a fixed viewport.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = path.join(REPO, "docs/screenshots");
const CREDS_FILE = path.join(REPO, "prisma/.bootstrap-credentials");
const BASE_URL = "http://localhost:3005";

function readCreds() {
  if (!fs.existsSync(CREDS_FILE)) {
    throw new Error(`No credentials file at ${CREDS_FILE}`);
  }
  const text = fs.readFileSync(CREDS_FILE, "utf8");
  const email = text.match(/^email=(.+)$/m)?.[1]?.trim();
  const password = text.match(/^password=(.+)$/m)?.[1]?.trim();
  if (!email || !password) throw new Error("creds file missing email/password");
  return { email, password };
}

async function login(page, { email, password }) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");

  // If forced password rotation, set it back to the same value so the
  // creds file remains accurate.
  if (page.url().endsWith("/password")) {
    await page.fill('input[name="currentPassword"]', password);
    await page.fill('input[name="newPassword"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.click('button[type="submit"]');
    await page.waitForLoadState("networkidle");
  }
}

async function shot(page, urlPath, file, opts = {}) {
  const target = `${BASE_URL}${urlPath}`;
  await page.goto(target);
  await page.waitForLoadState("networkidle");
  // Give SWR a beat to populate.
  await page.waitForTimeout(800);
  if (opts.beforeShot) await opts.beforeShot(page);
  const out = path.join(SCREENSHOTS_DIR, file);
  await page.screenshot({ path: out, fullPage: opts.fullPage ?? false });
  console.log(`  → ${file}`);
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const creds = readCreds();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // retina
  });
  const page = await ctx.newPage();
  await login(page, creds);

  console.log("Capturing screenshots:");
  await shot(page, "/", "dashboard.png");
  await shot(page, "/hosts", "hosts-list.png");
  await shot(page, "/vulnerabilities", "vulnerabilities-list.png");
  await shot(page, "/compliance", "compliance-scorecard.png", {
    fullPage: true,
  });
  await shot(page, "/settings/install", "install-agent.png", {
    fullPage: true,
    beforeShot: async (p) => {
      // Try to fill the token field if it's visible — non-fatal if the
      // placeholder text changes.
      try {
        const input = p.locator('input[placeholder*="argus_"]').first();
        await input.fill("argus_demo_token_for_screenshot_only", {
          timeout: 2000,
        });
        await p.waitForTimeout(200);
      } catch {
        // Leave the field blank — the snippet still renders with a
        // <your-token> placeholder which is fine for docs.
      }
    },
  });
  await shot(page, "/settings/collector", "collector-config.png", {
    fullPage: true,
  });

  // Host detail — navigate directly. ID 1 exists in the dev DB seed.
  await shot(page, "/hosts/1", "host-detail.png", { fullPage: true });

  await browser.close();
  console.log(`\nSaved to ${SCREENSHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
