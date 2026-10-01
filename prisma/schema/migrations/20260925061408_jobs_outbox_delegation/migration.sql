-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `emailTries` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `emailedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `SavedReport` ADD COLUMN `lastSentAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Task` ADD COLUMN `lastRecurredAt` DATETIME(3) NULL,
    ADD COLUMN `parentTaskId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `delegateToId` VARCHAR(191) NULL,
    ADD COLUMN `delegateUntil` DATETIME(3) NULL,
    ADD COLUMN `notifyEmail` BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX `Notification_emailedAt_emailTries_idx` ON `Notification`(`emailedAt`, `emailTries`);
