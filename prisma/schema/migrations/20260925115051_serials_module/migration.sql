-- Serial register moved from Inventory to its own module (resource key inventory.serial -> serials.item)
UPDATE `SearchIndex` SET `entityType` = 'serials.item', `module` = 'serials' WHERE `entityType` = 'inventory.serial';
UPDATE `SavedView` SET `resource` = 'serials.item' WHERE `resource` = 'inventory.serial';
UPDATE `AuditLog` SET `entityType` = 'serials.item' WHERE `entityType` = 'inventory.serial';
UPDATE `CustomField` SET `resource` = 'serials.item' WHERE `resource` = 'inventory.serial';
