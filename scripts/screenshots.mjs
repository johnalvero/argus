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

// Replacements applied to every screenshot's DOM text before capture.
// Order matters — longer/more-specific patterns first so they're not
// pre-shortened by an earlier rule.
const TEXT_REDACTIONS = [
  ["admin@convergeict.com", "admin@example.com"],
  ["johnhomer@gmail.com", "admin@example.com"],
  ["edge-noc-01.convergeict.com", "web-01.example.com"],
  ["edge-noc-01", "web-01"],
  ["CICTRELMAC002.local", "desktop-02.example.com"],
  ["CICTRELMAC002", "desktop-02"],
  ["convergeict.com", "example.com"],
  // Private IPs visible in dev fleet — swap for RFC 5737 documentation
  // range so the screenshots are unambiguously fake.
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "192.0.2.10"],
  [/\b172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}\b/g, "192.0.2.20"],
];

async function redactTextNodes(page) {
  await page.evaluate((rawReplacements) => {
    // Reconstruct regexes that crossed the bridge as serialized objects.
    const replacements = rawReplacements.map(([needle, repl]) => {
      if (typeof needle === "object" && needle.__regex) {
        return [new RegExp(needle.source, needle.flags), repl];
      }
      return [needle, repl];
    });
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    const updates = [];
    let n;
    while ((n = walker.nextNode())) {
      let txt = n.nodeValue ?? "";
      let changed = false;
      for (const [needle, repl] of replacements) {
        if (needle instanceof RegExp) {
          const next = txt.replace(needle, repl);
          if (next !== txt) {
            txt = next;
            changed = true;
          }
        } else if (txt.includes(needle)) {
          txt = txt.split(needle).join(repl);
          changed = true;
        }
      }
      if (changed) updates.push([n, txt]);
    }
    for (const [n, t] of updates) n.nodeValue = t;
    // Also redact input values (token placeholder, etc).
    for (const el of document.querySelectorAll("input, textarea")) {
      let v = el.value ?? "";
      let changed = false;
      for (const [needle, repl] of replacements) {
        if (needle instanceof RegExp) {
          const next = v.replace(needle, repl);
          if (next !== v) {
            v = next;
            changed = true;
          }
        } else if (v.includes(needle)) {
          v = v.split(needle).join(repl);
          changed = true;
        }
      }
      if (changed) el.value = v;
    }
  }, TEXT_REDACTIONS.map(([n, r]) =>
    n instanceof RegExp
      ? [{ __regex: true, source: n.source, flags: n.flags }, r]
      : [n, r]
  ));
}

async function shot(page, urlPath, file, opts = {}) {
  const target = `${BASE_URL}${urlPath}`;
  await page.goto(target);
  await page.waitForLoadState("networkidle");
  // Give SWR a beat to populate.
  await page.waitForTimeout(800);
  if (opts.beforeShot) await opts.beforeShot(page);
  await redactTextNodes(page);
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
