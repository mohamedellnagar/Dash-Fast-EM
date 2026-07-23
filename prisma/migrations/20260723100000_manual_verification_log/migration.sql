-- CreateTable
CREATE TABLE `ManualVerificationLog` (
    `id` VARCHAR(191) NOT NULL,
    `originalTestCode` VARCHAR(191) NOT NULL,
    `normalizedTestCode` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NULL,
    `localRecordFound` BOOLEAN NOT NULL DEFAULT false,
    `statusRequestSuccess` BOOLEAN NOT NULL DEFAULT false,
    `resultsRequestSuccess` BOOLEAN NOT NULL DEFAULT false,
    `fastTestStatus` VARCHAR(191) NULL,
    `statusHttpCode` INTEGER NULL,
    `resultsHttpCode` INTEGER NULL,
    `statusLatencyMs` INTEGER NULL,
    `resultsLatencyMs` INTEGER NULL,
    `requestedByUserId` VARCHAR(191) NULL,
    `correlationId` VARCHAR(191) NULL,
    `errorSummary` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ManualVerificationLog_normalizedTestCode_createdAt_idx`(`normalizedTestCode`, `createdAt`),
    INDEX `ManualVerificationLog_requestedByUserId_idx`(`requestedByUserId`),
    INDEX `ManualVerificationLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ManualVerificationLog` ADD CONSTRAINT `ManualVerificationLog_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `FastTestWorkspace`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManualVerificationLog` ADD CONSTRAINT `ManualVerificationLog_requestedByUserId_fkey` FOREIGN KEY (`requestedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

