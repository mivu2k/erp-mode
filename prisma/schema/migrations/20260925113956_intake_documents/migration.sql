-- AlterTable
ALTER TABLE `DeliveryOrder` ADD COLUMN `intakeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `intakeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Quotation` ADD COLUMN `intakeId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Invoice_intakeId_idx` ON `Invoice`(`intakeId`);

-- CreateIndex
CREATE INDEX `Quotation_intakeId_idx` ON `Quotation`(`intakeId`);
