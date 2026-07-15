-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    INDEX `User_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Role` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Role_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Permission_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RolePermission` (
    `roleId` VARCHAR(191) NOT NULL,
    `permissionId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserRole` (
    `userId` VARCHAR(191) NOT NULL,
    `roleId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserSchoolScope` (
    `userId` VARCHAR(191) NOT NULL,
    `schoolId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`userId`, `schoolId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `School` (
    `id` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `School_externalId_key`(`externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subject` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Subject_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Student` (
    `id` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `nameArabic` VARCHAR(191) NULL,
    `nameEnglish` VARCHAR(191) NULL,
    `emiratesId` VARCHAR(191) NULL,
    `grade` VARCHAR(191) NULL,
    `classCode` VARCHAR(191) NULL,
    `schoolId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Student_externalId_key`(`externalId`),
    INDEX `Student_schoolId_idx`(`schoolId`),
    INDEX `Student_grade_idx`(`grade`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FastTestWorkspace` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceName` VARCHAR(191) NOT NULL,
    `subjectCode` VARCHAR(191) NOT NULL,
    `baseUrl` VARCHAR(191) NOT NULL,
    `restApiKeyEncrypted` VARCHAR(191) NULL,
    `usernameEncrypted` VARCHAR(191) NULL,
    `passwordEncrypted` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `syncEnabled` BOOLEAN NOT NULL DEFAULT true,
    `syncPaused` BOOLEAN NOT NULL DEFAULT false,
    `tokenTTL` INTEGER NOT NULL DEFAULT 3600,
    `lastAuthenticationAt` DATETIME(3) NULL,
    `lastAuthenticationStatus` VARCHAR(191) NULL,
    `lastAuthenticationError` TEXT NULL,
    `lastSuccessfulSyncAt` DATETIME(3) NULL,
    `nextTokenRefreshAt` DATETIME(3) NULL,
    `authenticationDurationMs` INTEGER NULL,
    `authenticationFailureCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `FastTestWorkspace_subjectCode_idx`(`subjectCode`),
    INDEX `FastTestWorkspace_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkspaceSubjectMapping` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NULL,
    `subjectAlias` VARCHAR(191) NOT NULL,
    `aliasNormalized` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WorkspaceSubjectMapping_workspaceId_idx`(`workspaceId`),
    UNIQUE INDEX `WorkspaceSubjectMapping_aliasNormalized_key`(`aliasNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExamRegistration` (
    `id` VARCHAR(191) NOT NULL,
    `studentExternalId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NULL,
    `schoolId` VARCHAR(191) NULL,
    `subjectId` VARCHAR(191) NULL,
    `examSubject` VARCHAR(191) NOT NULL,
    `examName` VARCHAR(191) NULL,
    `grade` VARCHAR(191) NULL,
    `classCode` VARCHAR(191) NULL,
    `startDate` VARCHAR(191) NULL,
    `endDate` VARCHAR(191) NULL,
    `startTime` VARCHAR(191) NULL,
    `endTime` VARCHAR(191) NULL,
    `academicYear` VARCHAR(191) NULL,
    `proctorCode` VARCHAR(191) NULL,
    `accessToken` VARCHAR(191) NULL,
    `testCodeOriginal` VARCHAR(191) NOT NULL,
    `testCodeNormalized` VARCHAR(191) NOT NULL,
    `attendanceOriginal` VARCHAR(191) NULL,
    `workspaceId` VARCHAR(191) NULL,
    `fastTestStatus` VARCHAR(191) NULL,
    `dashboardStatus` VARCHAR(191) NOT NULL DEFAULT 'UNKNOWN',
    `fastTestTestId` VARCHAR(191) NULL,
    `fastTestTestName` VARCHAR(191) NULL,
    `fastTestExamineeId` VARCHAR(191) NULL,
    `fastTestRegistrationDate` VARCHAR(191) NULL,
    `actualStartTime` VARCHAR(191) NULL,
    `secondsUsed` INTEGER NULL,
    `lastSyncAt` DATETIME(3) NULL,
    `lastSuccessfulSyncAt` DATETIME(3) NULL,
    `syncStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `syncState` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `syncError` TEXT NULL,
    `syncRetryCount` INTEGER NOT NULL DEFAULT 0,
    `nextSyncAt` DATETIME(3) NULL,
    `syncPriority` INTEGER NOT NULL DEFAULT 100,
    `isStale` BOOLEAN NOT NULL DEFAULT false,
    `staleSince` DATETIME(3) NULL,
    `staleReason` TEXT NULL,
    `staleSeverity` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `ExamRegistration_dashboardStatus_idx`(`dashboardStatus`),
    INDEX `ExamRegistration_schoolId_idx`(`schoolId`),
    INDEX `ExamRegistration_subjectId_idx`(`subjectId`),
    INDEX `ExamRegistration_workspaceId_idx`(`workspaceId`),
    INDEX `ExamRegistration_syncStatus_idx`(`syncStatus`),
    INDEX `ExamRegistration_syncState_idx`(`syncState`),
    INDEX `ExamRegistration_nextSyncAt_idx`(`nextSyncAt`),
    INDEX `ExamRegistration_testCodeNormalized_idx`(`testCodeNormalized`),
    INDEX `ExamRegistration_isStale_idx`(`isStale`),
    UNIQUE INDEX `ExamRegistration_workspaceId_testCodeNormalized_key`(`workspaceId`, `testCodeNormalized`),
    UNIQUE INDEX `ExamRegistration_studentExternalId_examSubject_testCodeNorma_key`(`studentExternalId`, `examSubject`, `testCodeNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FastTestStatusSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `registrationId` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `dashboardStatus` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NULL,
    `testName` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `externalId` VARCHAR(191) NULL,
    `examineeId` VARCHAR(191) NULL,
    `registrationDate` VARCHAR(191) NULL,
    `rawJson` LONGTEXT NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FastTestStatusSnapshot_registrationId_idx`(`registrationId`),
    INDEX `FastTestStatusSnapshot_fetchedAt_idx`(`fetchedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FastTestResult` (
    `id` VARCHAR(191) NOT NULL,
    `registrationId` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `externalId` VARCHAR(191) NULL,
    `examineeId` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `registrationDate` VARCHAR(191) NULL,
    `testName` VARCHAR(191) NULL,
    `startTime` VARCHAR(191) NULL,
    `secondsUsed` INTEGER NULL,
    `passed` BOOLEAN NULL,
    `testSessionId` VARCHAR(191) NULL,
    `testSessionName` VARCHAR(191) NULL,
    `examineeGroupId` VARCHAR(191) NULL,
    `examineeGroupPath` VARCHAR(191) NULL,
    `constructorUrl` VARCHAR(191) NULL,
    `attemptedItems` INTEGER NULL,
    `totalItemsCount` INTEGER NULL,
    `completionPercentage` DOUBLE NULL,
    `durationFormatted` VARCHAR(191) NULL,
    `startDate` VARCHAR(191) NULL,
    `startTimeOnly` VARCHAR(191) NULL,
    `rawScore` DOUBLE NULL,
    `scaledScore` DOUBLE NULL,
    `sumScore` DOUBLE NULL,
    `cutScore` DOUBLE NULL,
    `correctCount` INTEGER NULL,
    `incorrectCount` INTEGER NULL,
    `skippedCount` INTEGER NULL,
    `schoolId` VARCHAR(191) NULL,
    `subjectId` VARCHAR(191) NULL,
    `grade` VARCHAR(191) NULL,
    `examSubject` VARCHAR(191) NULL,
    `rawJson` LONGTEXT NOT NULL,
    `lastSyncAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `syncStatus` VARCHAR(191) NOT NULL DEFAULT 'OK',
    `syncError` TEXT NULL,
    `syncRetryCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FastTestResult_registrationId_idx`(`registrationId`),
    INDEX `FastTestResult_schoolId_idx`(`schoolId`),
    INDEX `FastTestResult_subjectId_idx`(`subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FastTestScore` (
    `id` VARCHAR(191) NOT NULL,
    `resultId` VARCHAR(191) NOT NULL,
    `examineeTestId` VARCHAR(191) NULL,
    `subscore` VARCHAR(191) NULL,
    `name` VARCHAR(191) NULL,
    `rawScore` DOUBLE NULL,
    `sumScore` DOUBLE NULL,
    `cutScore` DOUBLE NULL,
    `scaledScore` DOUBLE NULL,
    `correct` INTEGER NULL,
    `incorrect` INTEGER NULL,
    `skipped` INTEGER NULL,
    `totalCorrect` INTEGER NULL,
    `totalIncorrect` INTEGER NULL,
    `totalSkipped` INTEGER NULL,
    `rawJson` LONGTEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FastTestScore_resultId_idx`(`resultId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SyncJob` (
    `id` VARCHAR(191) NOT NULL,
    `jobType` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `workspaceId` VARCHAR(191) NULL,
    `registrationId` VARCHAR(191) NULL,
    `testCodeNormalized` VARCHAR(191) NULL,
    `subject` VARCHAR(191) NULL,
    `schoolId` VARCHAR(191) NULL,
    `payload` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'QUEUED',
    `scheduledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `nextRetryAt` DATETIME(3) NULL,
    `lockedBy` VARCHAR(191) NULL,
    `lockedAt` DATETIME(3) NULL,
    `heartbeatAt` DATETIME(3) NULL,
    `lastErrorCode` VARCHAR(191) NULL,
    `lastErrorMessage` TEXT NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `correlationId` VARCHAR(191) NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SyncJob_status_priority_scheduledAt_idx`(`status`, `priority`, `scheduledAt`),
    INDEX `SyncJob_status_nextRetryAt_idx`(`status`, `nextRetryAt`),
    INDEX `SyncJob_registrationId_idx`(`registrationId`),
    INDEX `SyncJob_workspaceId_status_idx`(`workspaceId`, `status`),
    INDEX `SyncJob_jobType_status_idx`(`jobType`, `status`),
    INDEX `SyncJob_dedupeKey_idx`(`dedupeKey`),
    INDEX `SyncJob_lockedBy_idx`(`lockedBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SyncJobAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `workerId` VARCHAR(191) NULL,
    `endpoint` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `errorCategory` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `httpStatus` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `correlationId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `SyncJobAttempt_jobId_idx`(`jobId`),
    INDEX `SyncJobAttempt_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SyncStateTransition` (
    `id` VARCHAR(191) NOT NULL,
    `registrationId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NULL,
    `fromState` VARCHAR(191) NOT NULL,
    `toState` VARCHAR(191) NOT NULL,
    `reason` TEXT NULL,
    `correlationId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SyncStateTransition_registrationId_idx`(`registrationId`),
    INDEX `SyncStateTransition_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApiRequestLog` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NULL,
    `endpoint` VARCHAR(191) NOT NULL,
    `method` VARCHAR(191) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `respondedAt` DATETIME(3) NULL,
    `responseTimeMs` INTEGER NULL,
    `httpStatus` INTEGER NULL,
    `fastTestErrorCode` VARCHAR(191) NULL,
    `fastTestErrorMessage` TEXT NULL,
    `retryCount` INTEGER NOT NULL DEFAULT 0,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `correlationId` VARCHAR(191) NULL,

    INDEX `ApiRequestLog_workspaceId_idx`(`workspaceId`),
    INDEX `ApiRequestLog_requestedAt_idx`(`requestedAt`),
    INDEX `ApiRequestLog_success_idx`(`success`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `detail` TEXT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_userId_idx`(`userId`),
    INDEX `AuditLog_action_idx`(`action`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemSetting` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportJob` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `createdCount` INTEGER NOT NULL DEFAULT 0,
    `updatedCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `summaryJson` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImportJob_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImportError` (
    `id` VARCHAR(191) NOT NULL,
    `importJobId` VARCHAR(191) NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `column` VARCHAR(191) NULL,
    `value` TEXT NULL,
    `message` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ImportError_importJobId_idx`(`importJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SavedView` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `pageType` VARCHAR(191) NOT NULL,
    `filtersJson` VARCHAR(4000) NOT NULL DEFAULT '{}',
    `sortBy` VARCHAR(191) NULL,
    `sortDir` VARCHAR(191) NULL,
    `columnsJson` VARCHAR(2000) NOT NULL DEFAULT '[]',
    `pageSize` INTEGER NOT NULL DEFAULT 25,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isShared` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `SavedView_userId_pageType_idx`(`userId`, `pageType`),
    INDEX `SavedView_isShared_idx`(`isShared`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserTablePreference` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `pageType` VARCHAR(191) NOT NULL,
    `columnsJson` VARCHAR(2000) NOT NULL DEFAULT '[]',
    `pageSize` INTEGER NOT NULL DEFAULT 25,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserTablePreference_userId_pageType_key`(`userId`, `pageType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExportJob` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `exportType` VARCHAR(191) NOT NULL,
    `format` VARCHAR(191) NOT NULL,
    `filtersJson` VARCHAR(4000) NOT NULL DEFAULT '{}',
    `recordCount` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `failureReason` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdBy` VARCHAR(191) NULL,

    INDEX `ExportJob_userId_idx`(`userId`),
    INDEX `ExportJob_status_idx`(`status`),
    INDEX `ExportJob_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttentionItem` (
    `id` VARCHAR(191) NOT NULL,
    `registrationId` VARCHAR(191) NOT NULL,
    `schoolId` VARCHAR(191) NULL,
    `subjectId` VARCHAR(191) NULL,
    `issueType` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `lastError` TEXT NULL,
    `retryCount` INTEGER NOT NULL DEFAULT 0,
    `detail` TEXT NULL,
    `assignedToUserId` VARCHAR(191) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` VARCHAR(191) NULL,
    `firstDetectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastDetectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AttentionItem_status_severity_idx`(`status`, `severity`),
    INDEX `AttentionItem_schoolId_idx`(`schoolId`),
    INDEX `AttentionItem_issueType_idx`(`issueType`),
    UNIQUE INDEX `AttentionItem_registrationId_issueType_key`(`registrationId`, `issueType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttentionNote` (
    `id` VARCHAR(191) NOT NULL,
    `attentionItemId` VARCHAR(191) NOT NULL,
    `authorUserId` VARCHAR(191) NULL,
    `authorEmail` VARCHAR(191) NULL,
    `note` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AttentionNote_attentionItemId_idx`(`attentionItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkerInstance` (
    `id` VARCHAR(191) NOT NULL,
    `hostname` VARCHAR(191) NULL,
    `pid` INTEGER NULL,
    `version` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'HEALTHY',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastHeartbeatAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `currentJobs` INTEGER NOT NULL DEFAULT 0,
    `jobsCompleted` INTEGER NOT NULL DEFAULT 0,
    `jobsFailed` INTEGER NOT NULL DEFAULT 0,
    `avgJobDurationMs` INTEGER NOT NULL DEFAULT 0,
    `memoryMb` INTEGER NULL,
    `cpuPercent` DOUBLE NULL,
    `stoppedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WorkerInstance_status_idx`(`status`),
    INDEX `WorkerInstance_lastHeartbeatAt_idx`(`lastHeartbeatAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkerHeartbeat` (
    `id` VARCHAR(191) NOT NULL,
    `workerId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `currentJobs` INTEGER NOT NULL DEFAULT 0,
    `memoryMb` INTEGER NULL,
    `cpuPercent` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WorkerHeartbeat_workerId_createdAt_idx`(`workerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DistributedLock` (
    `key` VARCHAR(191) NOT NULL,
    `owner` VARCHAR(191) NOT NULL,
    `acquiredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `heartbeatAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `DistributedLock_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkspaceRateLimit` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `maxRps` DOUBLE NOT NULL DEFAULT 2,
    `maxRpm` INTEGER NOT NULL DEFAULT 60,
    `maxConcurrent` INTEGER NOT NULL DEFAULT 3,
    `maxBatch` INTEGER NOT NULL DEFAULT 25,
    `minDelayMs` INTEGER NOT NULL DEFAULT 200,
    `burst` INTEGER NOT NULL DEFAULT 5,
    `cooldownMs` INTEGER NOT NULL DEFAULT 30000,
    `authMaxConcurrent` INTEGER NULL,
    `statusMaxConcurrent` INTEGER NULL,
    `resultsMaxConcurrent` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkspaceCircuitBreaker` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'CLOSED',
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `openedAt` DATETIME(3) NULL,
    `nextProbeAt` DATETIME(3) NULL,
    `lastTrippedReason` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`workspaceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemAlert` (
    `id` VARCHAR(191) NOT NULL,
    `alertType` VARCHAR(191) NOT NULL,
    `severity` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `workspaceId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `assignedToUserId` VARCHAR(191) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` VARCHAR(191) NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `occurrences` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SystemAlert_dedupeKey_key`(`dedupeKey`),
    INDEX `SystemAlert_status_severity_idx`(`status`, `severity`),
    INDEX `SystemAlert_alertType_idx`(`alertType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AlertNote` (
    `id` VARCHAR(191) NOT NULL,
    `alertId` VARCHAR(191) NOT NULL,
    `authorUserId` VARCHAR(191) NULL,
    `authorEmail` VARCHAR(191) NULL,
    `note` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AlertNote_alertId_idx`(`alertId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QueueMetricSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `queuedJobs` INTEGER NOT NULL DEFAULT 0,
    `runningJobs` INTEGER NOT NULL DEFAULT 0,
    `retryScheduled` INTEGER NOT NULL DEFAULT 0,
    `deadLetterJobs` INTEGER NOT NULL DEFAULT 0,
    `completedLastMin` INTEGER NOT NULL DEFAULT 0,
    `failedLastMin` INTEGER NOT NULL DEFAULT 0,
    `oldestJobAgeMs` INTEGER NOT NULL DEFAULT 0,
    `activeWorkers` INTEGER NOT NULL DEFAULT 0,
    `staleRegistrations` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QueueMetricSnapshot_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkspaceHealthSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `circuitState` VARCHAR(191) NOT NULL,
    `avgResponseMs` INTEGER NOT NULL DEFAULT 0,
    `p95ResponseMs` INTEGER NOT NULL DEFAULT 0,
    `errorRate` DOUBLE NOT NULL DEFAULT 0,
    `requestCount` INTEGER NOT NULL DEFAULT 0,
    `staleCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WorkspaceHealthSnapshot_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QueueControl` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `scopeKey` VARCHAR(191) NOT NULL,
    `paused` BOOLEAN NOT NULL DEFAULT false,
    `reason` TEXT NULL,
    `updatedBy` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `QueueControl_scope_scopeKey_key`(`scope`, `scopeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RolePermission` ADD CONSTRAINT `RolePermission_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `Permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserRole` ADD CONSTRAINT `UserRole_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserSchoolScope` ADD CONSTRAINT `UserSchoolScope_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserSchoolScope` ADD CONSTRAINT `UserSchoolScope_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Student` ADD CONSTRAINT `Student_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceSubjectMapping` ADD CONSTRAINT `WorkspaceSubjectMapping_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceSubjectMapping` ADD CONSTRAINT `WorkspaceSubjectMapping_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `Subject`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamRegistration` ADD CONSTRAINT `ExamRegistration_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamRegistration` ADD CONSTRAINT `ExamRegistration_schoolId_fkey` FOREIGN KEY (`schoolId`) REFERENCES `School`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamRegistration` ADD CONSTRAINT `ExamRegistration_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `Subject`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamRegistration` ADD CONSTRAINT `ExamRegistration_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FastTestStatusSnapshot` ADD CONSTRAINT `FastTestStatusSnapshot_registrationId_fkey` FOREIGN KEY (`registrationId`) REFERENCES `ExamRegistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FastTestStatusSnapshot` ADD CONSTRAINT `FastTestStatusSnapshot_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FastTestResult` ADD CONSTRAINT `FastTestResult_registrationId_fkey` FOREIGN KEY (`registrationId`) REFERENCES `ExamRegistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FastTestResult` ADD CONSTRAINT `FastTestResult_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FastTestScore` ADD CONSTRAINT `FastTestScore_resultId_fkey` FOREIGN KEY (`resultId`) REFERENCES `FastTestResult`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncJob` ADD CONSTRAINT `SyncJob_registrationId_fkey` FOREIGN KEY (`registrationId`) REFERENCES `ExamRegistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncJob` ADD CONSTRAINT `SyncJob_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncJobAttempt` ADD CONSTRAINT `SyncJobAttempt_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `SyncJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SyncStateTransition` ADD CONSTRAINT `SyncStateTransition_registrationId_fkey` FOREIGN KEY (`registrationId`) REFERENCES `ExamRegistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ApiRequestLog` ADD CONSTRAINT `ApiRequestLog_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportJob` ADD CONSTRAINT `ImportJob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ImportError` ADD CONSTRAINT `ImportError_importJobId_fkey` FOREIGN KEY (`importJobId`) REFERENCES `ImportJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SavedView` ADD CONSTRAINT `SavedView_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserTablePreference` ADD CONSTRAINT `UserTablePreference_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExportJob` ADD CONSTRAINT `ExportJob_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttentionItem` ADD CONSTRAINT `AttentionItem_registrationId_fkey` FOREIGN KEY (`registrationId`) REFERENCES `ExamRegistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttentionItem` ADD CONSTRAINT `AttentionItem_assignedToUserId_fkey` FOREIGN KEY (`assignedToUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttentionNote` ADD CONSTRAINT `AttentionNote_attentionItemId_fkey` FOREIGN KEY (`attentionItemId`) REFERENCES `AttentionItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttentionNote` ADD CONSTRAINT `AttentionNote_authorUserId_fkey` FOREIGN KEY (`authorUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkerHeartbeat` ADD CONSTRAINT `WorkerHeartbeat_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `WorkerInstance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceRateLimit` ADD CONSTRAINT `WorkspaceRateLimit_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceCircuitBreaker` ADD CONSTRAINT `WorkspaceCircuitBreaker_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SystemAlert` ADD CONSTRAINT `SystemAlert_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SystemAlert` ADD CONSTRAINT `SystemAlert_assignedToUserId_fkey` FOREIGN KEY (`assignedToUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AlertNote` ADD CONSTRAINT `AlertNote_alertId_fkey` FOREIGN KEY (`alertId`) REFERENCES `SystemAlert`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AlertNote` ADD CONSTRAINT `AlertNote_authorUserId_fkey` FOREIGN KEY (`authorUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkspaceHealthSnapshot` ADD CONSTRAINT `WorkspaceHealthSnapshot_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
