-- AlterTable
ALTER TABLE `ExamRegistration` ADD COLUMN `programType` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `ExamRegistration_programType_idx` ON `ExamRegistration`(`programType`);
