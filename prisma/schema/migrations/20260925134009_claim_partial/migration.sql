-- AlterTable
ALTER TABLE `ExpenseClaim` ADD COLUMN `approvalNote` TEXT NULL,
    ADD COLUMN `approvedTotal` DECIMAL(18, 2) NULL,
    ADD COLUMN `booked` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ExpenseClaimLine` ADD COLUMN `approved` DECIMAL(18, 2) NULL;
