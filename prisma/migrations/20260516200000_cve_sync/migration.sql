-- CVE / vulnerability cache + per-host join + sync run audit.
--
-- Round B.1.a — data plumbing only. The UI for browsing vulnerabilities
-- lands in B.1.b; this migration ships the three tables the sync engine
-- writes to.

CREATE TABLE "Vulnerability" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "osvId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "severity" TEXT,
    "cvssScore" REAL,
    "aliases" TEXT,
    "references" TEXT,
    "publishedAt" DATETIME,
    "modifiedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "Vulnerability_osvId_key" ON "Vulnerability"("osvId");
CREATE INDEX "Vulnerability_severity_idx" ON "Vulnerability"("severity");
CREATE INDEX "Vulnerability_cvssScore_idx" ON "Vulnerability"("cvssScore");
CREATE INDEX "Vulnerability_modifiedAt_idx" ON "Vulnerability"("modifiedAt");

CREATE TABLE "HostVulnerability" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostId" INTEGER NOT NULL,
    "vulnerabilityId" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "packageVersion" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HostVulnerability_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HostVulnerability_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HostVulnerability_hostId_vulnerabilityId_packageName_packageVersion_key" ON "HostVulnerability"("hostId", "vulnerabilityId", "packageName", "packageVersion");
CREATE INDEX "HostVulnerability_hostId_idx" ON "HostVulnerability"("hostId");
CREATE INDEX "HostVulnerability_vulnerabilityId_idx" ON "HostVulnerability"("vulnerabilityId");

CREATE TABLE "CveSyncRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "packagesQueried" INTEGER NOT NULL DEFAULT 0,
    "vulnsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "hostsAffected" INTEGER NOT NULL DEFAULT 0,
    "newVulns" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredById" INTEGER,
    CONSTRAINT "CveSyncRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "CveSyncRun_startedAt_idx" ON "CveSyncRun"("startedAt");
