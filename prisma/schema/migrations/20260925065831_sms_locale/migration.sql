-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `smsAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `locale` VARCHAR(191) NOT NULL DEFAULT 'en',
    ADD COLUMN `notifySms` BOOLEAN NOT NULL DEFAULT false;
