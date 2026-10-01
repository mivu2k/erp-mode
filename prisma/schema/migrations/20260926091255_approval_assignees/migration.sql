-- CreateTable
CREATE TABLE `ApprovalAssignee` (
    `requestId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `step` INTEGER NOT NULL,

    INDEX `ApprovalAssignee_userId_idx`(`userId`),
    PRIMARY KEY (`requestId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ApprovalAssignee` ADD CONSTRAINT `ApprovalAssignee_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `ApprovalRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
