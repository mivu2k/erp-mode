-- Director finance removed: no Director accounts or expense types; personal ledgers are "Employee – name".
UPDATE `Account` SET `name` = 'Employee Accounts' WHERE `name` = 'Employee & Director Accounts';
UPDATE `Account` SET `name` = CONCAT('Employee – ', SUBSTRING(`name`, CHAR_LENGTH('Director – ') + 1)) WHERE `employeeId` IS NOT NULL AND `name` LIKE 'Director – %';

-- Director accounts with no entries are deleted; any that already carry entries stay (the books must balance), renamed.
UPDATE `Account` a SET a.`deletedAt` = NOW()
  WHERE a.`deletedAt` IS NULL AND a.`isGroup` = false AND a.`name` IN ('Director Capital', 'Director Travel', 'Director Entertainment')
  AND NOT EXISTS (SELECT 1 FROM `JournalLine` l WHERE l.`accountId` = a.`id`);
UPDATE `Account` SET `name` = 'Capital' WHERE `deletedAt` IS NULL AND `name` = 'Director Capital';
UPDATE `Account` SET `name` = 'Travel (other)' WHERE `deletedAt` IS NULL AND `name` = 'Director Travel';
UPDATE `Account` SET `name` = 'Entertainment' WHERE `deletedAt` IS NULL AND `name` = 'Director Entertainment';
-- The group goes once nothing is left under it; otherwise it is renamed.
UPDATE `Account` g SET g.`deletedAt` = NOW()
  WHERE g.`deletedAt` IS NULL AND g.`isGroup` = true AND g.`name` = 'Director Expenses'
  AND NOT EXISTS (SELECT 1 FROM (SELECT `parentId` FROM `Account` WHERE `deletedAt` IS NULL) c WHERE c.`parentId` = g.`id`);
UPDATE `Account` SET `name` = 'Other Expenses' WHERE `deletedAt` IS NULL AND `name` = 'Director Expenses';

-- Director expense types (old claims keep their lines; the types no longer appear in dropdowns).
UPDATE `MasterData` SET `deletedAt` = NOW() WHERE `type` = 'expense_head' AND `code` IN ('DIR-TRAVEL', 'DIR-ENT') AND `deletedAt` IS NULL;

-- The system-account setting no longer has a Director capital slot.
UPDATE `Setting` SET `value` = JSON_REMOVE(`value`, '$.directorCapital') WHERE `key` = 'finance.accounts' AND JSON_CONTAINS_PATH(`value`, 'one', '$.directorCapital');
