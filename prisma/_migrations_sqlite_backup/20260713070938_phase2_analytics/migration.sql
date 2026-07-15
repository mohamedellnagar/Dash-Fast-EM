-- AlterTable
ALTER TABLE "FastTestResult" ADD COLUMN "correctCount" INTEGER;
ALTER TABLE "FastTestResult" ADD COLUMN "cutScore" REAL;
ALTER TABLE "FastTestResult" ADD COLUMN "examSubject" TEXT;
ALTER TABLE "FastTestResult" ADD COLUMN "grade" TEXT;
ALTER TABLE "FastTestResult" ADD COLUMN "incorrectCount" INTEGER;
ALTER TABLE "FastTestResult" ADD COLUMN "rawScore" REAL;
ALTER TABLE "FastTestResult" ADD COLUMN "scaledScore" REAL;
ALTER TABLE "FastTestResult" ADD COLUMN "schoolId" TEXT;
ALTER TABLE "FastTestResult" ADD COLUMN "skippedCount" INTEGER;
ALTER TABLE "FastTestResult" ADD COLUMN "subjectId" TEXT;
ALTER TABLE "FastTestResult" ADD COLUMN "sumScore" REAL;

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pageType" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL DEFAULT '{}',
    "sortBy" TEXT,
    "sortDir" TEXT,
    "columnsJson" TEXT NOT NULL DEFAULT '[]',
    "pageSize" INTEGER NOT NULL DEFAULT 25,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "SavedView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserTablePreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "columnsJson" TEXT NOT NULL DEFAULT '[]',
    "pageSize" INTEGER NOT NULL DEFAULT 25,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserTablePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "exportType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filtersJson" TEXT NOT NULL DEFAULT '{}',
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdBy" TEXT,
    CONSTRAINT "ExportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttentionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registrationId" TEXT NOT NULL,
    "schoolId" TEXT,
    "subjectId" TEXT,
    "issueType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "lastError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "assignedToUserId" TEXT,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "firstDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AttentionItem_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttentionItem_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttentionNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attentionItemId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorEmail" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttentionNote_attentionItemId_fkey" FOREIGN KEY ("attentionItemId") REFERENCES "AttentionItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttentionNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SavedView_userId_pageType_idx" ON "SavedView"("userId", "pageType");

-- CreateIndex
CREATE INDEX "SavedView_isShared_idx" ON "SavedView"("isShared");

-- CreateIndex
CREATE UNIQUE INDEX "UserTablePreference_userId_pageType_key" ON "UserTablePreference"("userId", "pageType");

-- CreateIndex
CREATE INDEX "ExportJob_userId_idx" ON "ExportJob"("userId");

-- CreateIndex
CREATE INDEX "ExportJob_status_idx" ON "ExportJob"("status");

-- CreateIndex
CREATE INDEX "ExportJob_startedAt_idx" ON "ExportJob"("startedAt");

-- CreateIndex
CREATE INDEX "AttentionItem_status_severity_idx" ON "AttentionItem"("status", "severity");

-- CreateIndex
CREATE INDEX "AttentionItem_schoolId_idx" ON "AttentionItem"("schoolId");

-- CreateIndex
CREATE INDEX "AttentionItem_issueType_idx" ON "AttentionItem"("issueType");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionItem_registrationId_issueType_key" ON "AttentionItem"("registrationId", "issueType");

-- CreateIndex
CREATE INDEX "AttentionNote_attentionItemId_idx" ON "AttentionNote"("attentionItemId");

-- CreateIndex
CREATE INDEX "FastTestResult_schoolId_idx" ON "FastTestResult"("schoolId");

-- CreateIndex
CREATE INDEX "FastTestResult_subjectId_idx" ON "FastTestResult"("subjectId");
