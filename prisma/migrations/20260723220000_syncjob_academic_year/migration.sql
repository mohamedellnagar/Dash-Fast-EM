-- AlterTable
ALTER TABLE `SyncJob` ADD COLUMN `academicYear` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `SyncJob_academicYear_status_idx` ON `SyncJob`(`academicYear`, `status`);


-- Backfill existing jobs from their registration so a paused year takes effect
-- on the current backlog, not only on jobs created from now on.
UPDATE `SyncJob` j
  JOIN `ExamRegistration` r ON r.`id` = j.`registrationId`
  SET j.`academicYear` = r.`academicYear`
WHERE j.`academicYear` IS NULL AND r.`academicYear` IS NOT NULL;
