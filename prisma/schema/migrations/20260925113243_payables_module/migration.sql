-- Payables & Receivables became its own module: resource key finance.due -> payables.due
UPDATE `SearchIndex` SET `entityType` = 'payables.due', `module` = 'payables' WHERE `entityType` = 'finance.due';
UPDATE `JournalEntry` SET `sourceType` = 'payables.due' WHERE `sourceType` = 'finance.due';
UPDATE `Payment` SET `refType` = 'payables.due' WHERE `refType` = 'finance.due';
UPDATE `AuditLog` SET `entityType` = 'payables.due' WHERE `entityType` = 'finance.due';
UPDATE `Comment` SET `entityType` = 'payables.due' WHERE `entityType` = 'finance.due';
UPDATE `Attachment` SET `entityType` = 'payables.due' WHERE `entityType` = 'finance.due';
UPDATE `SavedView` SET `resource` = 'payables.due' WHERE `resource` = 'finance.due';
UPDATE `CustomField` SET `resource` = 'payables.due' WHERE `resource` = 'finance.due';
UPDATE `WorkflowDefinition` SET `resource` = 'payables.due' WHERE `resource` = 'finance.due';
UPDATE `Template` SET `key` = 'payables.due' WHERE `key` = 'finance.due';
