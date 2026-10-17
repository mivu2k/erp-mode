-- Extra barcodes per product (one per line); the main barcode stays in `barcode`.
ALTER TABLE `Product` ADD COLUMN `barcodes` TEXT NULL;
