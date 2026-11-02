-- Approval is one step: the first approver (or anyone with Approve rights) decides. Keep each workflow's first step,
-- and bring requests that were waiting at a later step back to it so they can still be decided.
UPDATE `WorkflowDefinition` SET `steps` = JSON_ARRAY(JSON_EXTRACT(`steps`, '$[0]')) WHERE JSON_LENGTH(`steps`) > 1;
UPDATE `ApprovalRequest` SET `step` = 0 WHERE `status` = 'pending' AND `step` > 0;
UPDATE `ApprovalAssignee` a JOIN `ApprovalRequest` r ON r.`id` = a.`requestId` SET a.`step` = 0 WHERE r.`status` = 'pending';
