-- Preserve existing draft link invites without assigning them to an arbitrary user.
-- New invites are always addressed; legacy rows with NULL inviteeId cannot be redeemed.
ALTER TABLE "WorkspaceInvite" ADD COLUMN "inviteeId" TEXT;
CREATE UNIQUE INDEX "WorkspaceInvite_workspaceId_inviteeId_key" ON "WorkspaceInvite"("workspaceId", "inviteeId");
CREATE INDEX "WorkspaceInvite_inviteeId_expiresAt_idx" ON "WorkspaceInvite"("inviteeId", "expiresAt");
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
