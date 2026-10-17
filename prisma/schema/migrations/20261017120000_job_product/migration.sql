-- Which inventory product a repaired unit is (from its barcode at intake).
ALTER TABLE `Job` ADD COLUMN `productId` VARCHAR(191) NULL;
CREATE INDEX `Job_productId_idx` ON `Job`(`productId`);
