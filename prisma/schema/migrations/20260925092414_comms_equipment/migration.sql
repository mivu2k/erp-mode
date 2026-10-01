-- AlterTable
ALTER TABLE `Job` ADD COLUMN `assetTag` VARCHAR(191) NULL,
    ADD COLUMN `firmwareVersion` VARCHAR(191) NULL,
    ADD COLUMN `frequencyBand` VARCHAR(191) NULL,
    ADD COLUMN `testResults` JSON NULL,
    ADD COLUMN `zeroized` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `Job_assetTag_idx` ON `Job`(`assetTag`);
