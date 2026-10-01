-- Employee types become a company-managed Master Data list ('employee_type'); Director is one of them.
INSERT INTO `MasterData` (`id`, `companyId`, `type`, `code`, `name`, `value`, `sort`, `isActive`, `createdAt`, `updatedAt`)
SELECT CONCAT('et', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 23)), c.id, 'employee_type', t.code, t.name, t.value, t.sort, true, NOW(3), NOW(3)
FROM `Company` c
CROSS JOIN (
  SELECT 'permanent' AS code, 'Permanent' AS name, NULL AS value, 0 AS sort UNION ALL
  SELECT 'probation', 'Probation', NULL, 1 UNION ALL
  SELECT 'contract', 'Contract', NULL, 2 UNION ALL
  SELECT 'intern', 'Intern', NULL, 3 UNION ALL
  SELECT 'consultant', 'Consultant', NULL, 4 UNION ALL
  SELECT 'director', 'Director', JSON_OBJECT('director', true), 5
) t
WHERE NOT EXISTS (SELECT 1 FROM `MasterData` m WHERE m.companyId = c.id AND m.type = 'employee_type' AND m.deletedAt IS NULL);

-- Existing directors get the Director type, so the flag and the type agree.
UPDATE `Employee` SET `type` = 'director' WHERE `isDirector` = true;
