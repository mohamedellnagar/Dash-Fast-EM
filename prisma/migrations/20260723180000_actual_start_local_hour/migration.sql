-- AlterTable
ALTER TABLE `ExamRegistration` ADD COLUMN `actualStartLocalHour` INTEGER NULL;

-- CreateIndex
CREATE INDEX `ExamRegistration_actualStartLocalHour_idx` ON `ExamRegistration`(`actualStartLocalHour`);

