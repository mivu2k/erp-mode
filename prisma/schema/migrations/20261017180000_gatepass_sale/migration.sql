-- Sale-out gatepasses carry the unit price per line.
ALTER TABLE `GatepassLine` ADD COLUMN `price` DECIMAL(18, 2) NULL;
