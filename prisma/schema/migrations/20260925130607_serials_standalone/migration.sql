-- AlterTable
ALTER TABLE `SerialItem` ADD COLUMN `brand` VARCHAR(191) NULL,
    ADD COLUMN `holder` VARCHAR(191) NULL,
    ADD COLUMN `itemName` VARCHAR(191) NULL,
    ADD COLUMN `location` VARCHAR(191) NULL,
    ADD COLUMN `model` VARCHAR(191) NULL,
    MODIFY `productId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `SerialEvent` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `serialItemId` VARCHAR(191) NOT NULL,
    `serial` VARCHAR(191) NOT NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `title` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `userId` VARCHAR(191) NULL,

    INDEX `SerialEvent_companyId_serial_idx`(`companyId`, `serial`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
