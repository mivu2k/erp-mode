-- Optional radio frequency on each serial unit, and on a gatepass line (copied to the unit when it goes out).
ALTER TABLE `SerialItem` ADD COLUMN `frequency` VARCHAR(191) NULL;
ALTER TABLE `GatepassLine` ADD COLUMN `frequency` VARCHAR(191) NULL;
