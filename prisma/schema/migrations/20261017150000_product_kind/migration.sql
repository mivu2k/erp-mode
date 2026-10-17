-- Repair spare parts are kept apart from sold products (own list, own store, repair pickers).
ALTER TABLE `Product` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'product';
CREATE INDEX `Product_companyId_kind_idx` ON `Product`(`companyId`, `kind`);
-- Items already used on repair jobs are spare parts.
UPDATE `Product` SET `kind` = 'part' WHERE `id` IN (SELECT DISTINCT `productId` FROM `JobPart`);
-- Every company gets a Workshop store for parts (unless it already has a repair store).
INSERT INTO `Warehouse` (`id`, `companyId`, `code`, `name`, `kind`, `createdAt`, `updatedAt`)
SELECT REPLACE(UUID(), '-', ''), c.`id`, 'WORKSHOP', 'Workshop store', 'repair', NOW(3), NOW(3) FROM `Company` c
WHERE NOT EXISTS (SELECT 1 FROM `Warehouse` w WHERE w.`companyId` = c.`id` AND (w.`kind` = 'repair' OR w.`code` = 'WORKSHOP'));
