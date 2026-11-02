-- Manual fines (late coming etc.): deducted in the payroll run for the month they're dated in.
CREATE TABLE `Fine` (
  `id` VARCHAR(191) NOT NULL,
  `companyId` VARCHAR(191) NOT NULL,
  `branchId` VARCHAR(191) NULL,
  `employeeId` VARCHAR(191) NOT NULL,
  `date` DATE NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `reason` VARCHAR(191) NOT NULL,
  `custom` JSON NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `deletedAt` DATETIME(3) NULL,
  INDEX `Fine_companyId_date_idx`(`companyId`, `date`),
  INDEX `Fine_employeeId_date_idx`(`employeeId`, `date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
