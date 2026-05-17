/** @type {import('next').NextConfig} */

// Baseline security headers. CSP is intentionally report-only for now
// — we want to surface violations in browser consoles without breaking
// the dashboard if a third-party asset URL slips through. Promote to
// enforcing once we've watched a few days of telemetry.
//
// We keep the policy permissive for inline styles ('unsafe-inline')
// because Tailwind + a few component libs emit them. Scripts are NOT
// 'unsafe-inline' — Next.js bundles all scripts, so there's no reason
// to allow inline.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    // Stripped automatically by browsers on plain-http responses, so
    // safe to set unconditionally even in dev.
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: CSP_REPORT_ONLY,
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Prisma's query engine is a native binary; Next must not bundle it.
  serverExternalPackages: ['@prisma/client', 'prisma'],
  // Ingest payloads can be a few hundred KB on package-heavy hosts.
  // The route handler enforces a 5 MB hard cap; align the body parser.
  experimental: {
    serverActions: { bodySizeLimit: '6mb' },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

module.exports = nextConfig;
