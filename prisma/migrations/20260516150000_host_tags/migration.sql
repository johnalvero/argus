-- First-class host tags.
--
-- Two new tables: Tag (the taxonomy) and HostTag (the join).
-- No seed rows — tag taxonomy is operator-defined. Downstream rounds
-- (CVE dashboard, watchlists, compliance scorecard) all read through
-- HostTag, so this lands first.

CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

CREATE TABLE "HostTag" (
    "hostId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("hostId", "tagId"),
    CONSTRAINT "HostTag_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "HostTag_tagId_idx" ON "HostTag"("tagId");
