ALTER TABLE `SerialItem` ADD COLUMN `employeeId` VARCHAR(191) NULL;
CREATE INDEX `SerialItem_employeeId_idx` ON `SerialItem`(`employeeId`);
