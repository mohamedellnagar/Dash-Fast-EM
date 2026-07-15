-- AlterTable
ALTER TABLE `ExamRegistration` ADD COLUMN `emiratesId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `ExamRegistration_deletedAt_idx` ON `ExamRegistration`(`deletedAt`);

-- CreateIndex
CREATE INDEX `ExamRegistration_emiratesId_idx` ON `ExamRegistration`(`emiratesId`);

-- CreateIndex
CREATE INDEX `ExamRegistration_deletedAt_dashboardStatus_idx` ON `ExamRegistration`(`deletedAt`, `dashboardStatus`);
