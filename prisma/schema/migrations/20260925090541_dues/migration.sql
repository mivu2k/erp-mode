-- CreateTable
CREATE TABLE `Due` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `number` VARCHAR(191) NULL,
    `direction` VARCHAR(191) NOT NULL,
    `partyType` VARCHAR(191) NOT NULL DEFAULT 'other',
    `customerId` VARCHAR(191) NULL,
    `vendorId` VARCHAR(191) NULL,
    `employeeId` VARCHAR(191) NULL,
    `partyName` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `paid` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `dueDate` DATE NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `journalId` VARCHAR(191) NULL,
    `custom` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Due_companyId_direction_status_idx`(`companyId`, `direction`, `status`),
    INDEX `Due_dueDate_idx`(`dueDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
