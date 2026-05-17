-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Host" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "osId" TEXT NOT NULL,
    "osName" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "osVersionCodename" TEXT,
    "kernel" TEXT,
    "arch" TEXT,
    "packageManager" TEXT,
    "agentVersion" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReportAt" DATETIME NOT NULL,
    "lastReportHash" TEXT
);

-- CreateTable
CREATE TABLE "Report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostId" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HostPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hostId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    CONSTRAINT "HostPackage_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER NOT NULL,
    "lastUsedAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "IngestToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Host_hostId_key" ON "Host"("hostId");

-- CreateIndex
CREATE INDEX "Host_lastReportAt_idx" ON "Host"("lastReportAt");

-- CreateIndex
CREATE INDEX "Report_hostId_receivedAt_idx" ON "Report"("hostId", "receivedAt");

-- CreateIndex
CREATE INDEX "HostPackage_name_idx" ON "HostPackage"("name");

-- CreateIndex
CREATE INDEX "HostPackage_name_version_idx" ON "HostPackage"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "HostPackage_hostId_name_version_arch_key" ON "HostPackage"("hostId", "name", "version", "arch");

-- CreateIndex
CREATE UNIQUE INDEX "IngestToken_tokenHash_key" ON "IngestToken"("tokenHash");

-- CreateIndex
CREATE INDEX "IngestToken_prefix_idx" ON "IngestToken"("prefix");
