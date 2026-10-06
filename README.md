# CodeSync

A portfolio project for a real-time collaborative development workspace. Requested stack: Next.js, React, TypeScript, Tailwind CSS, Monaco Editor, Express, Socket.IO, Yjs, PostgreSQL, and Prisma.

## Current checkpoint

**Phases 1–4 are complete and locally verified.** Authentication, profiles, workspace ownership and persistence remain intact. Workspaces now include a file/folder explorer and Monaco editor with explicit REST saves to PostgreSQL. Collaboration, sharing, and execution modules remain **unverified scaffolding**, not completed product features. No Phase 5+ frontend functionality is enabled.

Do not present this checkpoint as a finished collaborative editor. No cloud services have been provisioned or deployed.

## Development plan

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Project setup, database, landing page | Completed; working locally |
| 2 | Authentication, profile, dashboard | Completed; typecheck, build, database and auth/route integration checks passed |
| 3 | Workspace creation and persistence | Completed; CRUD, authorization, persistence/restart, regression tests and build passed |
| 4 | Monaco integration and file explorer | Completed; REST persistence, file/folder permissions, Monaco browser workflow and regressions passed |
| 5 | Socket.IO and Yjs synchronization | Backend draft; integration testing pending |
| 6 | Presence and live cursors | Socket event draft; frontend pending |
| 7 | Persistent real-time chat | Backend draft; frontend pending |
| 8 | Permissions, invites, member management | Backend draft; integration testing pending |
| 9 | Isolated execution | Judge0 adapter draft; sandbox provisioning/testing pending |
| 10 | Security, tests, performance | Pending |
| 11 | Full application polish | Landing page implemented; application UI pending |
| 12 | Production deployment | Setup guidance only; deployment pending |

Validate each phase before marking it complete or progressing to dependent phases.

## Architecture

```text
apps/
  web/                       Next.js application (Vercel)
    src/app/                 Routes and global styles
    src/components/          Reusable presentation components
  api/                       Persistent Node service (Render/Railway/Fly)
    prisma/                  PostgreSQL schema and migrations
    src/auth.ts              Opaque cookie sessions
    src/permissions.ts       Server authorization
    src/validation.ts        Zod validation
    src/app.ts               Express REST (auth/workspaces/files verified; later endpoints draft)
    src/files.ts             File/folder REST operations and content persistence
    src/realtime.ts          Socket.IO events (draft)
    src/documents.ts         Yjs document lifecycle (draft)
    src/execution.ts         Isolated runner adapter (draft)
```

The API runs separately from Next.js so a persistent service owns WebSocket connections. Authentication uses random opaque session cookies, stores only SHA-256 session token hashes, hashes passwords with bcrypt, and limits sessions to seven days. PostgreSQL remains the source of truth for users, workspace membership, files, and chat.

Phase 4 reads and saves plain `File.content` through REST and Prisma; it does not connect Monaco to Socket.IO or Yjs. The API entry point starts only its REST server, with Socket.IO startup disabled. The later-phase collaboration draft uses incremental Yjs updates, lazily loaded documents, debounced CRDT snapshots, and state-vector synchronization. Its integration with Phase 4 persistence remains Phase 5 work. This draft design requires **one backend instance**: horizontal scaling needs document ownership or a shared collaboration persistence design. Debounced collaborative saves can lose recent updates on a hard process crash; a durable update log is a future improvement.

Draft socket payloads carry validated positions for cursors; relative CRDT cursor positions should be implemented before promising stable cursor tracking under concurrent edits. File deletion/update concurrency and persistence failure handling need integration tests and further hardening.

## Database schema

| Entity | Purpose |
| --- | --- |
| User | Unique username and email, password hash, optional avatar, timestamps |
| Session | Hashed token, user foreign key, expiration |
| Workspace | Name, editing language, owner, timestamps |
| WorkspaceMember | Composite workspace/user key, role, joined/opened dates |
| File | Workspace-scoped tree, file/folder type, text and CRDT snapshot |
| Message | Workspace/user relations, message text, timestamp |
| WorkspaceInvite | Hashed invite token, inviter, role, expiration |

Relations use foreign keys and intentional cascades. Indexes cover memberships, workspace owners, file trees, recent messages, and session expiration. Server-side validation ensures a file parent belongs to its workspace. Future database hardening should add a uniqueness constraint for sibling names with nullable root parents.

## Local setup

Use Node.js 22 LTS or newer, npm, and PostgreSQL 16 (locally installed or Docker). The workspace machine currently has Node 25; LTS is preferable for deployment.

From the repository root:

```powershell
npm install
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env.local
docker compose up -d db
npm run db:generate
npm run db:deploy -w @codesync/api
npm run typecheck
npm run build
npm run dev
```

If using a local/cloud PostgreSQL installation instead of Docker, set `DATABASE_URL` accordingly and omit the Docker command. The initial migration and Phase 2 username uniqueness migration have been applied locally. `npm run db:migrate` creates subsequent development migrations; check generated SQL into version control. Production uses `npm run db:deploy -w @codesync/api`, never `migrate dev`. The username migration deliberately fails if an existing database contains duplicate usernames; resolve those account names before applying it. On Windows, stop the API before regenerating Prisma Client if its engine DLL is locked. If PowerShell blocks `npm.ps1`, use `npm.cmd` for these commands.

Frontend: `http://localhost:3000`. API: `http://localhost:4000`. `/health` checks the database connection. The frontend landing page can run without the API/database using `npm run dev -w @codesync/web`.

## Environment variables

| Variable | Location | Purpose |
| --- | --- | --- |
| DATABASE_URL | API | PostgreSQL connection string; use SSL in cloud |
| PORT | API | HTTP/WebSocket port; default 4000 |
| WEB_ORIGIN | API | Exact allowed frontend origin |
| NODE_ENV | API | `production` enables secure session cookies |
| COOKIE_CROSS_SITE | API | `true` uses SameSite=None, requiring HTTPS |
| EXECUTION_URL | API | Optional private Judge0-compatible sandbox URL |
| EXECUTION_API_KEY | API | Optional sandbox authentication token |
| NEXT_PUBLIC_API_URL | Web | Public browser-facing API URL |

No secret belongs in a `NEXT_PUBLIC_` variable. Environment files are ignored by Git.

## Phase 2 verification

Verified on the local Docker PostgreSQL database with the frontend at `http://localhost:3000` and API at `http://localhost:4000`:

- `npm run typecheck`: both workspaces passed.
- `npm run build`: Express TypeScript and Next.js production builds passed.
- Prisma Client generation, schema validation, and both committed migrations succeeded; migration status reports the database is up to date.
- `npm test`: the Phase 2 integration suite passed registration, server validation constraints, duplicate email/username conflicts, valid/invalid login, `GET /api/auth/me`, username editing and conflicts, logout, invalid/expired sessions, Origin rejection, bcrypt password storage, hashed session storage, seven-day expiry, and HttpOnly/SameSite cookie checks.
- Real HTTP checks passed: anonymous dashboard access redirects to login; authenticated dashboard renders username/email; authenticated login/register redirect to dashboard; dashboard access after logout redirects to login. API `/health` and frontend `/login` returned 200.

To rerun the integration suite, start PostgreSQL, apply migrations, and run **both** local services with `npm run dev` before running `npm test` in another terminal. Tests create unique temporary accounts in the configured database and delete only those accounts afterward. Run against a local development database. These are API and server-rendered route tests; the separate Phase 4 browser check below adds interactive authentication/editor coverage.

Registration validates username (2–32 characters), email, password (10–72 characters and at most 72 UTF-8 bytes), and matching confirmation in the frontend. The API independently validates persisted fields and enforces unique usernames/emails in PostgreSQL. Successful registration signs the user in immediately. Profile editing changes the username; email is displayed read-only, matching the existing API design.

Next.js forwards the incoming session cookie to Express `GET /api/auth/me` on protected route requests. Browser requests include credentials, and the dashboard rechecks the session on mount, focus, visibility changes, and every minute. Authentication failures redirect to login; service outages show an error. No auth tokens are stored in localStorage and no secrets are exposed through frontend environment variables.

## Phase 3 implementation and verification

Phase 3 reuses the existing `Workspace` and `WorkspaceMember` models. **No schema change or new migration was needed.** A workspace has its existing name, language, owner, and timestamps; the schema has no description field. Creation uses an atomic Prisma nested write to create both the workspace and its creator's `OWNER` membership. Language defaults to JavaScript when omitted and is selectable during creation. Rename updates the name only. Workspaces do not seed files in this phase.

All five workspace endpoints require the existing authenticated session. Listings are filtered by membership. Details require membership, and rename/delete require the `OWNER` role. Nonmembers receive 403, missing workspaces 404, invalid IDs or request bodies 400, and missing/expired sessions 401. Strict schemas reject unknown create/update fields, including client-provided `userId` or `ownerId`. Names are trimmed, required, and limited to 80 characters. Responses are not cached. Existing Origin protection remains in force. Deletion uses the existing cascading relations to remove membership, file, message, and invite records.

The dashboard retains profile editing and logout, and adds loading/error/retry states, workspace cards with role/owner/date information, an empty state, and creation links. `/workspace/new` provides validated creation with a language selector. `/workspace/[id]` verifies the session and access through Express before rendering details. Owner controls provide rename feedback and an inline delete confirmation with cancel. Successful creation opens the workspace; deletion returns to the dashboard. Browser data comes from credentialed API requests, never localStorage. Workspace pages recheck access on mount/focus and every minute.

Verification performed:

- `npm.cmd run typecheck` and `npm.cmd run build`: passed for API and web.
- `npm.cmd exec -w @codesync/api -- prisma validate`: passed.
- `npm.cmd run db:generate`: passed after briefly stopping the API to release its Windows engine DLL; API restarted afterward.
- `npm.cmd exec -w @codesync/api -- prisma migrate status`: both existing migrations applied; database up to date.
- `git diff --check`: passed.
- `npm.cmd test`: both Phase 2 and Phase 3 integration suites passed. Phase 3 covers create/list/details/rename/delete, name/language/ID/JSON validation, rejected ownership injection, Origin protection, database owner membership, unauthorized/expired authentication behavior (Phase 2 regression), nonmember denial, editor/viewer read-only permissions, actual workspace page rendering/access denial, refresh reads, logout/login persistence, a real separate API process stop/restart with persisted session and workspace, and deletion cascades.

The first sandboxed restart test failed because Windows user-info lookup in `tsx` returned `ENOMEM`; running the same suite outside the sandbox passed. Tests launch and stop their own temporary API process on a free port and clean up only uniquely named test accounts/workspaces. Start the normal frontend and API, plus PostgreSQL, before running `npm test`. The Phase 3 checkpoint used API and server-rendered route tests; Phase 4 adds the browser checks below. Workspace descriptions, language updates, and pagination remain outside this implementation.

### Manual browser verification

1. Run `npm.cmd run dev` with PostgreSQL running. Open `http://localhost:3000`, register/login as User A, and confirm the dashboard/profile/logout still work.
2. Click **Create Workspace**. Try a spaces-only name; expect a validation error. Enter `Phase 3 browser test`, select TypeScript, and submit. Expect the workspace detail page with User A as owner and role `OWNER`.
3. Go back to the dashboard. Confirm a card with the name, role, language, owner, and updated date. Open it and refresh; all workspace details must remain. Copy its URL/ID.
4. Rename it to `Phase 3 renamed`, save, and refresh. Confirm the new name on both the workspace page and dashboard.
5. Sign out, then sign in again as User A. Confirm the workspace remains. Restart `npm.cmd run dev`, refresh/login if needed, and confirm it still exists.
6. In an incognito window, register/login as User B. User A's workspace must be absent from User B's dashboard. Paste User A's workspace URL; expect an access-denied screen without its private details.
7. While User B is on `http://localhost:3000`, open browser DevTools Console, replace `WORKSPACE_ID` below with User A's ID, and run each request. Both must return **403**; User A's name/data must remain unchanged:

   ```js
   const workspaceApi = 'http://localhost:4000/api/workspaces/WORKSPACE_ID';
   (await fetch(workspaceApi, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized rename' }) })).status;
   (await fetch(workspaceApi, { method: 'DELETE', credentials: 'include' })).status;
   ```

8. As User A, open the workspace, click **Delete workspace**, then **Cancel**. Confirm it remains. Repeat and choose **Confirm delete**. Expect dashboard redirection and the card to disappear. Refresh the old URL; expect workspace not found.
9. Sign out and open `/workspace/new` or a workspace URL; expect login redirection. While authenticated, open `/workspace/invalid`; expect an invalid-link message.

## Phase 4 implementation and verification

Phase 4 reuses the existing `File` model and parent/folder relations. **No schema change or migration was required.** PostgreSQL remains the source of truth. Workspace settings, ownership, profile/session behavior, and authorization are preserved; workspace details/settings are now in an expandable section above the coding area.

Verified file APIs:

- `GET /api/workspaces/:id/files`: workspace-scoped file/folder metadata.
- `POST /api/workspaces/:id/files`: create an empty file or folder; optional `parentId` must identify a folder in that workspace.
- `GET /api/files/:id`: plain content and metadata for an accessible file; folders return 422.
- `PATCH /api/files/:id`: rename and/or save content.
- `POST /api/files/:id/save`: explicit REST content save using `{ content, updatedAt }` from the last read.
- `DELETE /api/files/:id`: delete a file or a folder and its descendants.

Reads require authenticated workspace membership; writes require `OWNER` or `EDITOR`. Viewers receive a read-only editor and no file mutation controls, with backend enforcement regardless of the UI. Unknown request fields and malformed IDs are rejected. Filenames follow the existing ASCII letters/numbers/spaces/dots/dashes/underscores rules, are trimmed, and are limited to 100 characters; slashes and `.`/`..` names are rejected. Duplicate sibling names and the existing 100-item workspace limit are checked inside serializable transactions. Content is limited to 200,000 UTF-8 bytes. Workspace timestamps update atomically with mutations.

Content saves require the file's `updatedAt` version and return 409 on a stale write. The editor retains the unsaved draft on failure; **Reload file** explicitly confirms discarding unsaved edits. A plain content save clears the unused draft CRDT snapshot; REST reads/saves do not use the Yjs document cache or emit collaboration events. The existing later-phase socket/document modules have not been expanded or connected to the editor.

The explorer supports root and nested file/folder creation, expanding folders, active-file indication, immediate create/rename/delete updates, confirmed deletion/cancel, and loading/empty/error/retry states. New files open automatically. Monaco maps `.ts/.tsx`, `.js/.jsx`, `.json`, `.html`, `.css`, `.md`, `.py`, `.java`, `.c`, and `.cpp` to their corresponding languages; unknown extensions use plaintext. Save and Ctrl/⌘+S persist content through REST. Keystrokes update only the in-memory draft and unsaved indicator; they send no persistence request. A successful save clears the unsaved marker and displays a saved state. Starting another edit clears the previous save notification. A failed save leaves the code and unsaved indicator intact and displays an error. Unsaved drafts are retained in memory while switching files, and refresh/leaving through page links prompts before discarding them. The selected file ID is stored in the URL query so refresh reopens it; neither file contents nor auth tokens are stored in localStorage.

Monaco and its React wrapper were already installed. `prepare:monaco` copies the installed Monaco assets and license into ignored `apps/web/public/monaco/`; `predev` and `prebuild` run it automatically. Runtime editor/worker assets are served locally rather than from a CDN. If your frontend dev server was already running before this phase, run `npm.cmd run prepare:monaco -w @codesync/web` once or restart it.

Verification passed:

- `npm.cmd run typecheck` and `npm.cmd run build`: API and web passed.
- Prisma schema validation, client generation, and migration status: valid; existing migrations up to date. The API was briefly stopped for the Windows engine lock, then restarted successfully.
- `git diff --check`: passed.
- `npm.cmd test`: all three integration suites passed, including Phase 2/3 regressions, file/folder CRUD, nested parent validation, duplicate-create concurrency, strict validation, size limits, stale-save conflicts, user isolation, editor/viewer permissions, logout/login persistence, recursive deletion, and saved file content surviving a real API process restart.
- `node apps/web/scripts/check-phase4-browser.mjs`: headless Chrome passed registration/dashboard, workspace/file creation, locally hosted Monaco loading, actual typing, exact PostgreSQL persistence, save/refresh/reopen, rename/refresh, saved-file persistence through browser logout/login, mobile editor width, viewer read-only editing, nested folders/files, Ctrl+S, unsaved drafts across file switches, stale-save failure preserving the code/unsaved state, confirmed reload, deletion cancellation/cascade/empty state, deletion remaining effective after refresh, and logout/login.
- Local Monaco worker asset and API health returned HTTP 200. The Socket.IO handshake URL returned 404, confirming no realtime server is active.

The browser helper uses installed Windows Chrome or Edge and creates/cleans up temporary database records. Start both normal services and PostgreSQL before running it. New empty Monaco models use the browser platform's default line endings (CRLF on this Windows machine); saves preserve the exact editor value. Other browsers, full mobile interaction, and production hosting have not been tested.

Remaining scope limits: saves are explicit, unsaved drafts are temporary until saved, no file moves/uploads, and no real-time collaboration, live cursors, presence, chat, invitations/member-management UI, execution, or deployment. Browser Back navigation is not intercepted by a custom navigation blocker; save drafts before leaving with browser history controls. Phase 5 has not been started.

### Manual Phase 4 browser checks

1. Login → dashboard → open/create a workspace. Expand **Workspace details & settings** and confirm Phase 3 rename/delete controls still work.
2. Click **New File**, create `index.ts`, type code, click **Save**, and refresh. Confirm the explorer and reopened Monaco editor show the saved file/code. Verify Ctrl/⌘+S also saves.
3. Try whitespace-only, slash-containing, and duplicate filenames; expect useful validation/conflict errors. Create `src`, then `src/main.py`; confirm expansion and Python highlighting.
4. Edit one file without saving, select another file, then return. Confirm its draft remains and displays an unsaved marker. Use **Reload file** and confirm the discard prompt restores the saved content.
5. Rename `index.ts` to `app.ts`, refresh, logout/login, and restart the dev servers. Confirm the filename and saved content remain.
6. Click delete and cancel; confirm nothing changes. Confirm deletion next; verify the row and editor selection disappear. Refresh and confirm the file remains absent. Confirm deleting a folder also removes descendants.
7. With two browser tabs open on the same file, save in the first tab, then attempt to save the stale second tab. Expect a conflict and retained draft; reload only after copying or saving any draft you want to keep.
8. Copy User A's workspace ID from `/workspace/ID` and selected file ID from `?file=ID`. In an incognito window, register/login as User B and paste User A's workspace URL; expect access denial. While User B is on `http://localhost:3000`, run the following in DevTools Console with the copied IDs. Every result must be 403, and User A's file must remain unchanged:

   ```js
   const phase4WorkspaceId = 'WORKSPACE_ID';
   const phase4FileId = 'FILE_ID';
   await Promise.all([
     ['GET', `/api/workspaces/${phase4WorkspaceId}/files`],
     ['GET', `/api/files/${phase4FileId}`],
     ['POST', `/api/workspaces/${phase4WorkspaceId}/files`, { name: 'denied.ts' }],
     ['PATCH', `/api/files/${phase4FileId}`, { name: 'denied.ts' }],
     ['POST', `/api/files/${phase4FileId}/save`, { content: 'denied' }],
     ['DELETE', `/api/files/${phase4FileId}`],
   ].map(async ([method, path, payload]) => {
     const response = await fetch(`http://localhost:4000${path}`, {
       method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
       ...(payload ? { body: JSON.stringify(payload) } : {}),
     });
     return { method, path, status: response.status };
   }));
   ```

   Viewer/editor roles are verified through database test fixtures. For a test viewer membership, the explorer is readable and Monaco is read-only; create/rename/save/delete requests must return 403. No sharing/member-management UI is introduced in this phase.
9. Test narrow viewport layout and a file with an unknown extension; expect a usable explorer/editor layout and plaintext highlighting.

## APIs (authentication/workspaces/files verified; later phases drafted)

- Auth: `POST /api/auth/register`, `/login`, `/logout`; `GET/PATCH /api/auth/me`.
- Workspaces: `GET/POST /api/workspaces`; `GET/PATCH/DELETE /api/workspaces/:id`.
- Sharing: `POST /api/workspaces/:id/invites`, `POST /api/invites/join`.
- Membership: `PATCH/DELETE /api/workspaces/:id/members/:userId`.
- Files: `GET/POST /api/workspaces/:id/files`; `GET/PATCH/DELETE /api/files/:id`; `POST /api/files/:id/save`.
- Chat: `GET/POST /api/workspaces/:id/messages`.
- Execution: `POST /api/files/:id/run` with optional `stdin`.

REST writes require an `Origin` header matching `WEB_ORIGIN` to prevent cross-site request forgery. Authentication uses credentialed cookies. Validation errors return 400, missing sessions 401, unauthorized actions 403, conflicts 409, expired invitations 410, execution unavailable 503, and execution timeout 504.

Draft Socket.IO events: `workspace:join`, `file:subscribe`, `code:update`, `cursor`, `chat:send`; server broadcasts `presence`, `activity`, `chat:message`, `files:changed`, `file:deleted`, and `access:revoked`. Acknowledgements have `{ok,data}` or `{ok:false,error}`.

## Execution design

Never execute user code in the API process. The optional adapter sends JavaScript/Python to a separate Judge0-compatible runner with 2-second CPU, 5-second wall time, 64 MB memory, 16-process/thread, and 64 KB file limits, with networking disabled. The API request times out after 10 seconds and limits displayed output.

Provision and validate a patched, private sandbox service on a separate host before enabling execution. Provider behavior and actual isolation must be tested: configuration fields alone do not guarantee isolation. Unconfigured execution returns a useful 503 response. Other languages remain editing-only. The current adapter still needs streaming response caps and deployment-specific language ID verification in Phase 9.

## Deployment plan

1. Provision managed PostgreSQL and set the API connection URL with SSL.
2. Deploy the persistent API from the monorepo, install dependencies, generate Prisma Client, apply committed migrations, build, and start `npm run start -w @codesync/api`.
3. Deploy `apps/web` to Vercel, with `NEXT_PUBLIC_API_URL` set before the frontend build.
4. Set `WEB_ORIGIN` to the actual frontend domain; use HTTPS/WSS and one backend instance initially.
5. Prefer `app.example.com` and `api.example.com` on the same site. Unrelated Vercel/Render domains require SameSite=None cookies; browser third-party cookie policies can still block them.
6. Verify two authenticated browser sessions, simultaneous edits, reconnects, save/rejoin, viewer rejection, expired invites, role revocation, chat persistence, and sandbox resource limits before release.

Deployment is intentionally deferred until functional phases and required integration tests pass.

## Future improvements

Durable CRDT update log, shared document ownership for multiple servers, relative-position awareness cursors, offline editing, cursor throttling, file deletion locks, shared rate limiting, session cleanup, pagination, accessible application dialogs, secure password reset/email verification, audit logs, execution queues, and end-to-end browser tests.

## Reference documentation

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Prisma 6 schema documentation](https://docs.prisma.io/docs/orm/v6/prisma-schema/overview)
- [Yjs Monaco binding](https://github.com/yjs/y-monaco)
