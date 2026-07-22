-- CreateIndex
CREATE INDEX `ApiRequestLog_workspaceId_requestedAt_idx` ON `ApiRequestLog`(`workspaceId`, `requestedAt`);

-- CreateIndex
CREATE INDEX `ApiRequestLog_success_requestedAt_idx` ON `ApiRequestLog`(`success`, `requestedAt`);
