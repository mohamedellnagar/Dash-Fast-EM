-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    PRIMARY KEY ("roleId", "permissionId"),
    CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "roleId"),
    CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserSchoolScope" (
    "userId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,

    PRIMARY KEY ("userId", "schoolId"),
    CONSTRAINT "UserSchoolScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserSchoolScope_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "School" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT NOT NULL,
    "nameArabic" TEXT,
    "nameEnglish" TEXT,
    "emiratesId" TEXT,
    "grade" TEXT,
    "classCode" TEXT,
    "schoolId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Student_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FastTestWorkspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceName" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "restApiKeyEncrypted" TEXT,
    "usernameEncrypted" TEXT,
    "passwordEncrypted" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tokenTTL" INTEGER NOT NULL DEFAULT 3600,
    "lastAuthenticationAt" DATETIME,
    "lastAuthenticationStatus" TEXT,
    "lastAuthenticationError" TEXT,
    "lastSuccessfulSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WorkspaceSubjectMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "subjectId" TEXT,
    "subjectAlias" TEXT NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceSubjectMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceSubjectMapping_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExamRegistration" (
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
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "nextSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ExamRegistration_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExamRegistration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FastTestStatusSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registrationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dashboardStatus" TEXT NOT NULL,
    "testId" TEXT,
    "testName" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "externalId" TEXT,
    "examineeId" TEXT,
    "registrationDate" TEXT,
    "rawJson" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FastTestStatusSnapshot_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FastTestStatusSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FastTestResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registrationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "externalId" TEXT,
    "examineeId" TEXT,
    "email" TEXT,
    "registrationDate" TEXT,
    "testName" TEXT,
    "startTime" TEXT,
    "secondsUsed" INTEGER,
    "passed" BOOLEAN,
    "testSessionId" TEXT,
    "testSessionName" TEXT,
    "examineeGroupId" TEXT,
    "examineeGroupPath" TEXT,
    "constructorUrl" TEXT,
    "attemptedItems" INTEGER,
    "totalItemsCount" INTEGER,
    "completionPercentage" REAL,
    "durationFormatted" TEXT,
    "startDate" TEXT,
    "startTimeOnly" TEXT,
    "rawJson" TEXT NOT NULL,
    "lastSyncAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncStatus" TEXT NOT NULL DEFAULT 'OK',
    "syncError" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FastTestResult_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FastTestResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FastTestScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resultId" TEXT NOT NULL,
    "examineeTestId" TEXT,
    "subscore" TEXT,
    "name" TEXT,
    "rawScore" REAL,
    "sumScore" REAL,
    "cutScore" REAL,
    "scaledScore" REAL,
    "correct" INTEGER,
    "incorrect" INTEGER,
    "skipped" INTEGER,
    "totalCorrect" INTEGER,
    "totalIncorrect" INTEGER,
    "totalSkipped" INTEGER,
    "rawJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FastTestScore_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "FastTestResult" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "registrationId" TEXT,
    "workspaceId" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "scheduledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "lockedBy" TEXT,
    "lockedAt" DATETIME,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncJob_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ExamRegistration" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SyncJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorType" TEXT,
    "errorMessage" TEXT,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "correlationId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SyncJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    "responseTimeMs" INTEGER,
    "httpStatus" INTEGER,
    "fastTestErrorCode" TEXT,
    "fastTestErrorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "correlationId" TEXT,
    CONSTRAINT "ApiRequestLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "FastTestWorkspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "detail" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportError" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importJobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "column" TEXT,
    "value" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportError_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "School_externalId_key" ON "School"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_code_key" ON "Subject"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Student_externalId_key" ON "Student"("externalId");

-- CreateIndex
CREATE INDEX "Student_schoolId_idx" ON "Student"("schoolId");

-- CreateIndex
CREATE INDEX "Student_grade_idx" ON "Student"("grade");

-- CreateIndex
CREATE INDEX "FastTestWorkspace_subjectCode_idx" ON "FastTestWorkspace"("subjectCode");

-- CreateIndex
CREATE INDEX "FastTestWorkspace_isActive_idx" ON "FastTestWorkspace"("isActive");

-- CreateIndex
CREATE INDEX "WorkspaceSubjectMapping_workspaceId_idx" ON "WorkspaceSubjectMapping"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceSubjectMapping_aliasNormalized_key" ON "WorkspaceSubjectMapping"("aliasNormalized");

-- CreateIndex
CREATE INDEX "ExamRegistration_dashboardStatus_idx" ON "ExamRegistration"("dashboardStatus");

-- CreateIndex
CREATE INDEX "ExamRegistration_schoolId_idx" ON "ExamRegistration"("schoolId");

-- CreateIndex
CREATE INDEX "ExamRegistration_subjectId_idx" ON "ExamRegistration"("subjectId");

-- CreateIndex
CREATE INDEX "ExamRegistration_workspaceId_idx" ON "ExamRegistration"("workspaceId");

-- CreateIndex
CREATE INDEX "ExamRegistration_syncStatus_idx" ON "ExamRegistration"("syncStatus");

-- CreateIndex
CREATE INDEX "ExamRegistration_nextSyncAt_idx" ON "ExamRegistration"("nextSyncAt");

-- CreateIndex
CREATE INDEX "ExamRegistration_testCodeNormalized_idx" ON "ExamRegistration"("testCodeNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "ExamRegistration_workspaceId_testCodeNormalized_key" ON "ExamRegistration"("workspaceId", "testCodeNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "ExamRegistration_studentExternalId_examSubject_testCodeNormalized_key" ON "ExamRegistration"("studentExternalId", "examSubject", "testCodeNormalized");

-- CreateIndex
CREATE INDEX "FastTestStatusSnapshot_registrationId_idx" ON "FastTestStatusSnapshot"("registrationId");

-- CreateIndex
CREATE INDEX "FastTestStatusSnapshot_fetchedAt_idx" ON "FastTestStatusSnapshot"("fetchedAt");

-- CreateIndex
CREATE INDEX "FastTestResult_registrationId_idx" ON "FastTestResult"("registrationId");

-- CreateIndex
CREATE INDEX "FastTestScore_resultId_idx" ON "FastTestScore"("resultId");

-- CreateIndex
CREATE INDEX "SyncJob_status_scheduledAt_idx" ON "SyncJob"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "SyncJob_registrationId_idx" ON "SyncJob"("registrationId");

-- CreateIndex
CREATE INDEX "SyncAttempt_jobId_idx" ON "SyncAttempt"("jobId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_workspaceId_idx" ON "ApiRequestLog"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_requestedAt_idx" ON "ApiRequestLog"("requestedAt");

-- CreateIndex
CREATE INDEX "ApiRequestLog_success_idx" ON "ApiRequestLog"("success");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_idx" ON "ImportJob"("status");

-- CreateIndex
CREATE INDEX "ImportError_importJobId_idx" ON "ImportError"("importJobId");
