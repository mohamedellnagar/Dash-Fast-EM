-- AlterTable
ALTER TABLE `ExamRegistration` ADD COLUMN `actualStartTimeResolution` VARCHAR(191) NULL,
    ADD COLUMN `actualStartTimeUtc` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `FastTestResult` ADD COLUMN `startTimeResolution` VARCHAR(191) NULL,
    ADD COLUMN `startTimeSourceTz` VARCHAR(191) NULL,
    ADD COLUMN `startTimeUtc` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `FastTestResult_startTimeUtc_idx` ON `FastTestResult`(`startTimeUtc`);

