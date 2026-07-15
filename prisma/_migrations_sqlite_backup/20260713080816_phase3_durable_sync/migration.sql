/*
  Warnings:

  - You are about to drop the `SyncAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `attempts` on the `SyncJob` table. All the data in the column will be lost.
  - You are about to drop the column `finishedAt` on the `SyncJob` table. All the data in the column will be lost.
  - You are about to drop the column `lastError` on the `SyncJob` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "SyncAttempt_jobId_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SyncAttempt";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "SyncJobAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "workerId" TEXT,
    "endpoint" TEXT,
    "status" TEXT NOT NULL,
    "errorCategory" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "correlationId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "SyncJobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SyncJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncStateTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registrationId" TEXT NOT NULL,
    "jobId" TEXT,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "reason" TEXT,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncStateTransition_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkerInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT,
    "pid" INTEGER,
    "version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HEALTHY',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentJobs" INTEGER NOT NULL DEFAULT 0,
    "jobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "jobsFailed" INTEGER NOT NULL DEFAULT 0,
    "avgJobDurationMs" INTEGER NOT NULL DEFAULT 0,
    "memoryMb" INTEGER,
    "cpuPercent" REAL,
    "stoppedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentJobs" INTEGER NOT NULL DEFAULT 0,
    "memoryMb" INTEGER,
    "cpuPercent" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkerHeartbeat_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DistributedLock" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "owner" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkspaceRateLimit" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "maxRps" REAL NOT NULL DEFAULT 2,
    "maxRpm" INTEGER NOT NULL DEFAULT 60,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 3,
    "maxBatch" INTEGER NOT NULL DEFAULT 25,
    "minDelayMs" INTEGER NOT NULL DEFAULT 200,
    "burst" INTEGER NOT NULL DEFAULT 5,
    "cooldownMs" INTEGER NOT NULL DEFAULT 30000,
    "authMaxConcurrent" INTEGER,
    "statusMaxConcurrent" INTEGER,
    "resultsMaxConcurrent" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceRateLimit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkspaceCircuitBreaker" (
    "workspaceId" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "openedAt" DATETIME,
    "nextProbeAt" DATETIME,
    "lastTrippedReason" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceCircuitBreaker_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "workspaceId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "dedupeKey" TEXT,
    "assignedToUserId" TEXT,
    "acknowledgedAt" DATETIME,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SystemAlert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SystemAlert_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlertNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorEmail" TEXT,
    "note" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertNote_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "SystemAlert" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AlertNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueueMetricSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "queuedJobs" INTEGER NOT NULL DEFAULT 0,
    "runningJobs" INTEGER NOT NULL DEFAULT 0,
    "retryScheduled" INTEGER NOT NULL DEFAULT 0,
    "deadLetterJobs" INTEGER NOT NULL DEFAULT 0,
    "completedLastMin" INTEGER NOT NULL DEFAULT 0,
    "failedLastMin" INTEGER NOT NULL DEFAULT 0,
    "oldestJobAgeMs" INTEGER NOT NULL DEFAULT 0,
    "activeWorkers" INTEGER NOT NULL DEFAULT 0,
    "staleRegistrations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkspaceHealthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "circuitState" TEXT NOT NULL,
    "avgResponseMs" INTEGER NOT NULL DEFAULT 0,
    "p95ResponseMs" INTEGER NOT NULL DEFAULT 0,
    "errorRate" REAL NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceHealthSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueueControl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ExamRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentExternalId" TEXT NOT NULL,
    "studentId" TEXT,
    "schoolId" TEXT,
    "subjectId" TEXT,
    "examSubject" TEXT NOT NULL,
    "examName" TEXT,
    "grade" TEXT,
    "classCode" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "academicYear" TEXT,
    "proctorCode" TEXT,
    "accessToken" TEXT,
    "testCodeOriginal" TEXT NOT NULL,
    "testCodeNormalized" TEXT NOT NULL,
    "attendanceOriginal" TEXT,
    "workspaceId" TEXT,
    "fastTestStatus" TEXT,
    "dashboardStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "fastTestTestId" TEXT,
    "fastTestTestName" TEXT,
    "fastTestExamineeId" TEXT,
    "fastTestRegistrationDate" TEXT,
    "actualStartTime" TEXT,
    "secondsUsed" INTEGER,
    "lastSyncAt" DATETIME,
    "lastSuccessfulSyncAt" DATETIME,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncState" TEXT NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextSyncAt" DATETIME,
    "syncPriority" INTEGER NOT NULL DEFAULT 100,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "staleSince" DATETIME,
    "staleReason" TEXT,
    "staleSeverity" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ExamRegistration_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExamRegistration" ("academicYear", "accessToken", "actualStartTime", "attendanceOriginal", "classCode", "createdAt", "dashboardStatus", "deletedAt", "endDate", "endTime", "examName", "examSubject", "fastTestExamineeId", "fastTestRegistrationDate", "fastTestStatus", "fastTestTestId", "fastTestTestName", "grade", "id", "lastSyncAt", "nextSyncAt", "proctorCode", "schoolId", "secondsUsed", "startDate", "startTime", "studentExternalId", "studentId", "subjectId", "syncError", "syncRetryCount", "syncStatus", "testCodeNormalized", "testCodeOriginal", "updatedAt", "workspaceId") SELECT "academicYear", "accessToken", "actualStartTime", "attendanceOriginal", "classCode", "createdAt", "dashboardStatus", "deletedAt", "endDate", "endTime", "examName", "examSubject", "fastTestExamineeId", "fastTestRegistrationDate", "fastTestStatus", "fastTestTestId", "fastTestTestName", "grade", "id", "lastSyncAt", "nextSyncAt", "proctorCode", "schoolId", "secondsUsed", "startDate", "startTime", "studentExternalId", "studentId", "subjectId", "syncError", "syncRetryCount", "syncStatus", "testCodeNormalized", "testCodeOriginal", "updatedAt", "workspaceId" FROM "ExamRegistration";
DROP TABLE "ExamRegistration";
ALTER TABLE "new_ExamRegistration" RENAME TO "ExamRegistration";
CREATE INDEX "ExamRegistration_dashboardStatus_idx" ON "ExamRegistration"("dashboardStatus");
CREATE INDEX "ExamRegistration_schoolId_idx" ON "ExamRegistration"("schoolId");
CREATE INDEX "ExamRegistration_subjectId_idx" ON "ExamRegistration"("subjectId");
CREATE INDEX "ExamRegistration_workspaceId_idx" ON "ExamRegistration"("workspaceId");
CREATE INDEX "ExamRegistration_syncStatus_idx" ON "ExamRegistration"("syncStatus");
CREATE INDEX "ExamRegistration_syncState_idx" ON "ExamRegistration"("syncState");
CREATE INDEX "ExamRegistration_nextSyncAt_idx" ON "ExamRegistration"("nextSyncAt");
CREATE INDEX "ExamRegistration_testCodeNormalized_idx" ON "ExamRegistration"("testCodeNormalized");
CREATE INDEX "ExamRegistration_isStale_idx" ON "ExamRegistration"("isStale");
CREATE UNIQUE INDEX "ExamRegistration_workspaceId_testCodeNormalized_key" ON "ExamRegistration"("workspaceId", "testCodeNormalized");
CREATE UNIQUE INDEX "ExamRegistration_studentExternalId_examSubject_testCodeNormalized_key" ON "ExamRegistration"("studentExternalId", "examSubject", "testCodeNormalized");
CREATE TABLE "new_FastTestWorkspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceName" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "restApiKeyEncrypted" TEXT,
    "usernameEncrypted" TEXT,
    "passwordEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "syncPaused" BOOLEAN NOT NULL DEFAULT false,
    "tokenTTL" INTEGER NOT NULL DEFAULT 3600,
    "lastAuthenticationAt" DATETIME,
    "lastAuthenticationStatus" TEXT,
    "lastAuthenticationError" TEXT,
    "lastSuccessfulSyncAt" DATETIME,
    "nextTokenRefreshAt" DATETIME,
    "authenticationDurationMs" INTEGER,
    "authenticationFailureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);
INSERT INTO "new_FastTestWorkspace" ("baseUrl", "createdAt", "deletedAt", "id", "isActive", "lastAuthenticationAt", "lastAuthenticationError", "lastAuthenticationStatus", "lastSuccessfulSyncAt", "passwordEncrypted", "restApiKeyEncrypted", "subjectCode", "syncEnabled", "tokenTTL", "updatedAt", "usernameEncrypted", "workspaceName") SELECT "baseUrl", "createdAt", "deletedAt", "id", "isActive", "lastAuthenticationAt", "lastAuthenticationError", "lastAuthenticationStatus", "lastSuccessfulSyncAt", "passwordEncrypted", "restApiKeyEncrypted", "subjectCode", "syncEnabled", "tokenTTL", "updatedAt", "usernameEncrypted", "workspaceName" FROM "FastTestWorkspace";
DROP TABLE "FastTestWorkspace";
ALTER TABLE "new_FastTestWorkspace" RENAME TO "FastTestWorkspace";
CREATE INDEX "FastTestWorkspace_subjectCode_idx" ON "FastTestWorkspace"("subjectCode");
CREATE INDEX "FastTestWorkspace_isActive_idx" ON "FastTestWorkspace"("isActive");
CREATE TABLE "new_SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobType" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "workspaceId" TEXT,
    "registrationId" TEXT,
    "testCodeNormalized" TEXT,
    "subject" TEXT,
    "schoolId" TEXT,
    "payload" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "scheduledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" DATETIME,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "heartbeatAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "dedupeKey" TEXT,
    "correlationId" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncJob_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SyncJob" ("correlationId", "createdAt", "id", "jobType", "lockedAt", "lockedBy", "maxAttempts", "priority", "registrationId", "scheduledAt", "startedAt", "status", "updatedAt", "workspaceId") SELECT "correlationId", "createdAt", "id", "jobType", "lockedAt", "lockedBy", "maxAttempts", "priority", "registrationId", "scheduledAt", "startedAt", "status", "updatedAt", "workspaceId" FROM "SyncJob";
DROP TABLE "SyncJob";
ALTER TABLE "new_SyncJob" RENAME TO "SyncJob";
CREATE INDEX "SyncJob_status_priority_scheduledAt_idx" ON "SyncJob"("status", "priority", "scheduledAt");
CREATE INDEX "SyncJob_status_nextRetryAt_idx" ON "SyncJob"("status", "nextRetryAt");
CREATE INDEX "SyncJob_registrationId_idx" ON "SyncJob"("registrationId");
CREATE INDEX "SyncJob_workspaceId_status_idx" ON "SyncJob"("workspaceId", "status");
CREATE INDEX "SyncJob_jobType_status_idx" ON "SyncJob"("jobType", "status");
CREATE INDEX "SyncJob_dedupeKey_idx" ON "SyncJob"("dedupeKey");
CREATE INDEX "SyncJob_lockedBy_idx" ON "SyncJob"("lockedBy");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SyncJobAttempt_jobId_idx" ON "SyncJobAttempt"("jobId");

-- CreateIndex
CREATE INDEX "SyncJobAttempt_startedAt_idx" ON "SyncJobAttempt"("startedAt");

-- CreateIndex
CREATE INDEX "SyncStateTransition_registrationId_idx" ON "SyncStateTransition"("registrationId");

-- CreateIndex
CREATE INDEX "SyncStateTransition_createdAt_idx" ON "SyncStateTransition"("createdAt");

-- CreateIndex
CREATE INDEX "WorkerInstance_status_idx" ON "WorkerInstance"("status");

-- CreateIndex
CREATE INDEX "WorkerInstance_lastHeartbeatAt_idx" ON "WorkerInstance"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_workerId_createdAt_idx" ON "WorkerHeartbeat"("workerId", "createdAt");

-- CreateIndex
CREATE INDEX "DistributedLock_expiresAt_idx" ON "DistributedLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemAlert_dedupeKey_key" ON "SystemAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "SystemAlert_status_severity_idx" ON "SystemAlert"("status", "severity");

-- CreateIndex
CREATE INDEX "SystemAlert_alertType_idx" ON "SystemAlert"("alertType");

-- CreateIndex
CREATE INDEX "AlertNote_alertId_idx" ON "AlertNote"("alertId");

-- CreateIndex
CREATE INDEX "QueueMetricSnapshot_createdAt_idx" ON "QueueMetricSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceHealthSnapshot_workspaceId_createdAt_idx" ON "WorkspaceHealthSnapshot"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QueueControl_scope_scopeKey_key" ON "QueueControl"("scope", "scopeKey");
