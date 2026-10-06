-- Preserve existing accounts; fail rather than silently rename duplicate usernames.
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
