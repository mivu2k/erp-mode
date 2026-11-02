-- P & R is its own register: a due no longer needs a ledger account.
ALTER TABLE `Due` MODIFY `accountId` VARCHAR(191) NULL;
-- Utility bills now carry their own payable in the ledger: the dues P & R made for them are removed from P & R
-- (the bills, their ledger entries and payments are unchanged).
UPDATE `Due` d JOIN `UtilityBill` b ON b.`dueId` = d.`id` SET d.`deletedAt` = NOW() WHERE d.`deletedAt` IS NULL;
