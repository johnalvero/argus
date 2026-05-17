import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

/**
 * GET /api/search?package=<name>&version=<optional>
 *
 * Fuzzy on the package name (`LIKE %name%`) — matches the spec. When
 * `version` is supplied it's an exact-match filter against the package
 * version column. Returns a flat list of (host, package) pairs ordered
 * by hostname.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const url = new URL(req.url);
  const name = url.searchParams.get("package")?.trim() ?? "";
  const version = url.searchParams.get("version")?.trim() ?? "";
  if (name.length < 2) {
    return NextResponse.json(
      { error: "package query must be at least 2 chars" },
      { status: 400 }
    );
  }

  const rows = await prisma.hostPackage.findMany({
    where: {
      name: { contains: name },
      ...(version ? { version } : {}),
    },
    include: {
      host: {
        select: {
          id: true,
          hostId: true,
          hostname: true,
          osName: true,
          osVersion: true,
        },
      },
    },
    orderBy: [{ name: "asc" }, { version: "asc" }],
    take: 500,
  });

  return NextResponse.json(
    rows.map((r) => ({
      hostId: r.host.id,
      hostExternalId: r.host.hostId,
      hostname: r.host.hostname,
      osName: r.host.osName,
      osVersion: r.host.osVersion,
      package: { name: r.name, version: r.version, arch: r.arch },
    }))
  );
}
