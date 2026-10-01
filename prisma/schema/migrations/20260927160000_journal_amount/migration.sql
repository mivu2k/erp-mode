-- Entry size (sum of debits) so journal lists and headers can show an amount.
ALTER TABLE `JournalEntry` ADD COLUMN `amount` DECIMAL(18, 2) NOT NULL DEFAULT 0;
UPDATE `JournalEntry` j JOIN (SELECT `entryId`, SUM(`debit`) AS total FROM `JournalLine` GROUP BY `entryId`) l ON l.`entryId` = j.`id` SET j.`amount` = l.total;
