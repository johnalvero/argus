-- Server-driven feature toggles for the SBOM agent.
--
-- Singleton row keyed by name="default". Defaults match the agent's
-- compiled-in behavior so this migration is a true no-op for hosts
-- that have not been redeployed.

CREATE TABLE "CollectorConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "collectOsPackages" BOOLEAN NOT NULL DEFAULT true,
    "collectLanguagePackages" BOOLEAN NOT NULL DEFAULT true,
    "collectIpAddresses" BOOLEAN NOT NULL DEFAULT true,
    "collectServices" BOOLEAN NOT NULL DEFAULT true,
    "collectListeners" BOOLEAN NOT NULL DEFAULT true,
    "collectContainers" BOOLEAN NOT NULL DEFAULT true,
    "collectKernelMitigations" BOOLEAN NOT NULL DEFAULT false,
    "collectLoadedModules" BOOLEAN NOT NULL DEFAULT false,
    "collectPendingUpdates" BOOLEAN NOT NULL DEFAULT false,
    "collectContainerRuntime" BOOLEAN NOT NULL DEFAULT false,
    "collectVirtualization" BOOLEAN NOT NULL DEFAULT false,
    "collectUptime" BOOLEAN NOT NULL DEFAULT false,
    "collectSnapPackages" BOOLEAN NOT NULL DEFAULT false,
    "collectFlatpakPackages" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "CollectorConfig_name_key" ON "CollectorConfig"("name");

-- Seed the singleton row so the agent's GET works immediately on a
-- fresh deploy. All booleans take their column DEFAULTs.
INSERT INTO "CollectorConfig" ("name", "updatedAt")
VALUES ('default', CURRENT_TIMESTAMP);
