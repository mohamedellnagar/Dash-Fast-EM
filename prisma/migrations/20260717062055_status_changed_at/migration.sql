-- AlterTable
ALTER TABLE `ExamRegistration` ADD COLUMN `statusChangedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `ExamRegistration_statusChangedAt_idx` ON `ExamRegistration`(`statusChangedAt`);
