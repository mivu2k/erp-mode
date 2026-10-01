-- CreateTable
CREATE TABLE `UtilitySite` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `code` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` TEXT NULL,
    `contactPerson` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `notes` TEXT NULL,
    `custom` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `UtilitySite_companyId_idx`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UtilityConnection` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'electricity',
    `vendorId` VARCHAR(191) NULL,
    `provider` VARCHAR(191) NULL,
    `accountNo` VARCHAR(191) NULL,
    `meterNo` VARCHAR(191) NULL,
    `unit` VARCHAR(191) NULL,
    `tariff` DECIMAL(18, 4) NULL,
    `fixedCharge` DECIMAL(18, 2) NULL,
    `billingDay` INTEGER NOT NULL DEFAULT 1,
    `dueDays` INTEGER NOT NULL DEFAULT 14,
    `accountId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `notes` TEXT NULL,
    `custom` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `UtilityConnection_companyId_siteId_idx`(`companyId`, `siteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UtilityReading` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `connectionId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `reading` DECIMAL(18, 3) NOT NULL,
    `previous` DECIMAL(18, 3) NULL,
    `consumption` DECIMAL(18, 3) NULL,
    `meterReplaced` BOOLEAN NOT NULL DEFAULT false,
    `photo` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `UtilityReading_connectionId_date_idx`(`connectionId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UtilityBill` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `number` VARCHAR(191) NULL,
    `connectionId` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NULL,
    `billRef` VARCHAR(191) NULL,
    `periodFrom` DATE NULL,
    `periodTo` DATE NULL,
    `billDate` DATE NOT NULL,
    `dueDate` DATE NULL,
    `units` DECIMAL(18, 3) NULL,
    `energyCharge` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `fixedCharge` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `tax` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `otherCharges` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `arrears` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `lateAmount` DECIMAL(18, 2) NULL,
    `paid` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'unpaid',
    `dueId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `custom` JSON NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `UtilityBill_companyId_connectionId_billDate_idx`(`companyId`, `connectionId`, `billDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
