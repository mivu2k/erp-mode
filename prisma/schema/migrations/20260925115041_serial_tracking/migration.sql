-- AlterTable
ALTER TABLE `Product` ADD COLUMN `warrantyMonths` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `SerialItem` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `custom` JSON NULL,
    ADD COLUMN `customerId` VARCHAR(191) NULL,
    ADD COLUMN `notes` TEXT NULL,
    ADD COLUMN `receivedAt` DATETIME(3) NULL,
    ADD COLUMN `soldAt` DATETIME(3) NULL,
    ADD COLUMN `vendorId` VARCHAR(191) NULL,
    ADD COLUMN `warrantyUntil` DATE NULL;

-- CreateIndex
CREATE INDEX `SerialItem_customerId_idx` ON `SerialItem`(`customerId`);

-- CreateIndex
CREATE INDEX `SerialItem_warrantyUntil_idx` ON `SerialItem`(`warrantyUntil`);
