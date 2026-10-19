-- Technician asks the store for parts, and hands unused parts back for the store to receive.
ALTER TABLE `JobPart` ADD COLUMN `requestedQty` DECIMAL(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN `requestedAt` DATETIME(3) NULL,
  ADD COLUMN `requestedById` VARCHAR(191) NULL,
  ADD COLUMN `handbackQty` DECIMAL(18, 3) NOT NULL DEFAULT 0;
