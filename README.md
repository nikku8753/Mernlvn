# CodeSync

A portfolio project for a real-time collaborative development workspace. Requested stack: Next.js, React, TypeScript, Tailwind CSS, Monaco Editor, Express, Socket.IO, Yjs, PostgreSQL, and Prisma.

## Current checkpoint

**Phases 1–6 are complete and locally verified.** Authentication, profiles, workspaces, file/folder management and Monaco remain intact. Authorized members edit the same file through Socket.IO and Yjs with durable PostgreSQL snapshots, ephemeral presence, live cursors and selections. Phase 6 passed automated API and Chrome checks; exact normal-Chrome/Incognito manual instructions are below. Sharing/member-management UI, chat, execution and deployment remain deferred; existing later-phase REST drafts are unverified.

This checkpoint is a local, single-API-instance collaborative editor. No cloud services have been provisioned or deployed.

## Development plan

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Project setup, database, landing page | Completed; working locally |
| 2 | Authentication, profile, dashboard | Completed; typecheck, build, database and auth/route integration checks passed |
| 3 | Workspace creation and persistence | Completed; CRUD, authorization, persistence/restart, regression tests and build passed |
| 4 | Monaco integration and file explorer | Completed; REST persistence, file/folder permissions, Monaco browser workflow and regressions passed |
| 5 | Socket.IO and Yjs synchronization | Completed; concurrent editing, authorization, persistence/restart, reconnect and browser regressions passed |
| 6 | Presence and live cursors/selections | Completed; authorization/lifecycle, process restart, typecheck, build and Chrome regressions passed |
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
    src/realtime.ts          Authenticated file synchronization on the Express HTTP server
    src/documents.ts         Yjs document lifecycle and PostgreSQL snapshots
    src/execution.ts         Isolated runner adapter (draft)
```

The API runs separately from Next.js so a persistent service owns WebSocket connections. Authentication uses random opaque session cookies, stores only SHA-256 session token hashes, hashes passwords with bcrypt, and limits sessions to seven days. PostgreSQL remains the source of truth for users, workspace membership, files, and chat.

Socket.IO shares the existing Express HTTP server. Yjs owns one isolated document per file, Monaco binds to its `code` text, and PostgreSQL stores both readable `File.content` and the existing binary `File.state` snapshot. This design requires **one backend instance**; horizontal scaling needs shared document ownership/persistence. See Phase 5 below for save and reconnect behavior.

Phase 6 adds ephemeral file-scoped presence and Yjs relative-position cursors/selections on the same authenticated Socket.IO connection. Monaco decorations and text-only user labels render remote activity. PostgreSQL stores durable file content and CRDT snapshots, never cursor or presence state. Chat socket handlers remain deferred.

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

## Phase 4 implementation and verification (historical checkpoint)

Phase 4 reuses the existing `File` model and parent/folder relations. **No schema change or migration was required.** PostgreSQL remains the source of truth. Workspace settings, ownership, profile/session behavior, and authorization are preserved; workspace details/settings are now in an expandable section above the coding area.

Verified file APIs:

- `GET /api/workspaces/:id/files`: workspace-scoped file/folder metadata.
- `POST /api/workspaces/:id/files`: create an empty file or folder; optional `parentId` must identify a folder in that workspace.
- `GET /api/files/:id`: plain content and metadata for an accessible file; folders return 422.
- `PATCH /api/files/:id`: rename and/or save content.
- `POST /api/files/:id/save`: explicit REST content save using `{ content, updatedAt }` from the last read.
- `DELETE /api/files/:id`: delete a file or a folder and its descendants.

Reads require authenticated workspace membership; writes require `OWNER` or `EDITOR`. Viewers receive a read-only editor and no file mutation controls, with backend enforcement regardless of the UI. Unknown request fields and malformed IDs are rejected. Filenames follow the existing ASCII letters/numbers/spaces/dots/dashes/underscores rules, are trimmed, and are limited to 100 characters; slashes and `.`/`..` names are rejected. Duplicate sibling names and the existing 100-item workspace limit are checked inside serializable transactions. Content is limited to 200,000 UTF-8 bytes. Workspace timestamps update atomically with mutations.

Standalone REST content saves still require the file's `updatedAt` version and return 409 on a stale write, clearing `File.state` on success. The Phase 4 checkpoint used explicit REST saves and confirmed draft discard on reload. Phase 5 replaces editor full-text saves with shared-document flushes; reload/switching now flush pending edits and retain the page if saving fails. REST content replacement is rejected while a collaborative document is open.

The explorer supports root and nested file/folder creation, expanding folders, active-file indication, immediate create/rename/delete updates, confirmed deletion/cancel, and loading/empty/error/retry states. New files open automatically. Monaco maps `.ts/.tsx`, `.js/.jsx`, `.json`, `.html`, `.css`, `.md`, `.py`, `.java`, `.c`, and `.cpp` to their corresponding languages; unknown extensions use plaintext. Save and Ctrl/⌘+S persist content through REST. Keystrokes update only the in-memory draft and unsaved indicator; they send no persistence request. A successful save clears the unsaved marker and displays a saved state. Starting another edit clears the previous save notification. A failed save leaves the code and unsaved indicator intact and displays an error. Unsaved drafts are retained in memory while switching files, and refresh/leaving through page links prompts before discarding them. The selected file ID is stored in the URL query so refresh reopens it; neither file contents nor auth tokens are stored in localStorage.

Monaco and its React wrapper were already installed. `prepare:monaco` copies the installed Monaco assets and license into ignored `apps/web/public/monaco/`; `predev` and `prebuild` run it automatically. Runtime editor/worker assets are served locally rather than from a CDN. If your frontend dev server was already running before this phase, run `npm.cmd run prepare:monaco -w @codesync/web` once or restart it.

Verification passed:

- `npm.cmd run typecheck` and `npm.cmd run build`: API and web passed.
- Prisma schema validation, client generation, and migration status: valid; existing migrations up to date. The API was briefly stopped for the Windows engine lock, then restarted successfully.
- `git diff --check`: passed.
- `npm.cmd test`: all three integration suites passed, including Phase 2/3 regressions, file/folder CRUD, nested parent validation, duplicate-create concurrency, strict validation, size limits, stale-save conflicts, user isolation, editor/viewer permissions, logout/login persistence, recursive deletion, and saved file content surviving a real API process restart.
- `node apps/web/scripts/check-phase4-browser.mjs`: headless Chrome passed registration/dashboard, workspace/file creation, locally hosted Monaco loading, actual typing, exact PostgreSQL persistence, save/refresh/reopen, rename/refresh, saved-file persistence through browser logout/login, mobile editor width, viewer read-only editing, nested folders/files, Ctrl+S, unsaved drafts across file switches, stale-save failure preserving the code/unsaved state, confirmed reload, deletion cancellation/cascade/empty state, deletion remaining effective after refresh, and logout/login.
- At the Phase 4 checkpoint, local Monaco worker assets/API health returned HTTP 200 and the Socket.IO handshake returned 404. Socket.IO is enabled and verified in Phase 5.

The browser helper uses installed Windows Chrome or Edge and creates/cleans up temporary database records. Start both normal services and PostgreSQL before running it. New empty Monaco models use the browser platform's default line endings (CRLF on this Windows machine); saves preserve the exact editor value. Other browsers, full mobile interaction, and production hosting have not been tested.

The paragraphs above record Phase 4 behavior and checks at that checkpoint. Current Phase 5 save behavior and Phase 6 presence/cursors are documented below. File moves/uploads, chat, invitations/member-management UI, execution and deployment remain deferred. Browser Back navigation has no custom navigation blocker; confirm a saved state before leaving through browser history.

### Manual Phase 4 browser checks

1. Login → dashboard → open/create a workspace. Expand **Workspace details & settings** and confirm Phase 3 rename/delete controls still work.
2. Click **New File**, create `index.ts`, type code, click **Save**, and refresh. Confirm the explorer and reopened Monaco editor show the saved file/code. Verify Ctrl/⌘+S also saves.
3. Try whitespace-only, slash-containing, and duplicate filenames; expect useful validation/conflict errors. Create `src`, then `src/main.py`; confirm expansion and Python highlighting.
4. Edit one file, select another file, then return. Phase 5 flushes the shared draft before switching; confirm the code remains. Reload also preserves shared edits. While offline with pending edits, switching/reload must fail clearly and retain the current editor.
5. Rename `index.ts` to `app.ts`, refresh, logout/login, and restart the dev servers. Confirm the filename and saved content remain.
6. Click delete and cancel; confirm nothing changes. Confirm deletion next; verify the row and editor selection disappear. Refresh and confirm the file remains absent. Confirm deleting a folder also removes descendants.
7. With two authenticated tabs open on the same file, edits now synchronize automatically. Save flushes their shared Yjs state. A separate REST content replacement must return 409 while collaboration is active; standalone REST stale-version protection remains covered by API tests.
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

## Phase 5 implementation and verification

Socket.IO is the realtime transport on the existing persistent Express server; Yjs is the CRDT/document synchronization layer; Monaco is the editor interface; PostgreSQL is durable storage. Existing Socket.IO, Yjs and y-monaco packages were reused. **No dependencies, Prisma models or migrations were added/changed.**

Each file uses its own `Y.Doc` with `getText('code')`, keyed by its globally unique file ID, and a `workspace:WORKSPACE_ID:file:FILE_ID` room. A first join restores `File.state` or seeds from `File.content`; the seed's CRDT identity is persisted before clients receive it. Later joins exchange state vectors and missing incremental updates without replacing active state. `MonacoBinding` is created without awareness; receiving remote updates cannot echo them back. Rename keeps the same binding/document identity. Switching destroys the old binding/listeners/socket, flushes pending edits first, and opens a fresh file session. Deleting files/folders removes cached descendant documents and notifies affected editors.

Socket handshakes require the exact `WEB_ORIGIN` and a valid existing HttpOnly session cookie. The server resolves identity using the existing SHA-256 session-token lookup and seven-day expiry. Every event revalidates the session; file operations check the actual file's workspace membership, and updates/saves require OWNER or EDITOR. Recipients are reauthorized before receiving document content, including session/membership revocation. Identifiers, byte arrays, CRDT payloads and size limits are validated. Viewers synchronize read-only. No client-provided user/owner ID is trusted.

### Saving and reconnecting

- Incremental updates synchronize immediately; PostgreSQL is not written on each keystroke.
- Snapshots atomically persist readable text, binary CRDT state and workspace/file timestamps after **1.5 seconds of inactivity**, or approximately **10 seconds during continuous editing**, subject to queue/database availability.
- Save / Ctrl+S / Cmd+S waits for pending update acknowledgements, then `file:save` flushes the server's current shared document. It never sends a stale full-text replacement. Persistence errors retain the local document, display an error and retry background persistence after 5 seconds.
- Last-client disconnect flushes before eviction. Graceful API shutdown closes sockets and waits for queued snapshots. File mutations, eviction, snapshots and workspace deletion share a serialization queue to avoid delete/save races.
- Existing REST CRUD stays available. Full-text PATCH/REST save returns 409 while a document is cached/open; when no document is open, the original `updatedAt` protection and snapshot clearing remain intact. REST reads return the last durable snapshot, whereas active editors receive live Yjs state.
- A temporary disconnect retains the client's Y.Doc/binding in memory. Reconnect authenticates and authorizes again, receives missing server changes, then sends missing retained client changes using state vectors. Connecting/Connected/Reconnecting/Offline indicators describe the connection only.
- Saving failures block dirty-file switching/reload; the draft stays open. Reload no longer discards a shared draft. Unsaved navigation/unload prompts remain. Opening a file initially requires a working API/realtime connection.

Limitations: run **one API instance**. A hard process crash or database outage can lose edits not yet snapshotted if every client also closes; there is no durable update log or offline localStorage. Retained offline edits survive only while the page remains open. File text is limited to 200 KB UTF-8, and snapshots/updates to 2 MB. Database-outage retry behavior is implemented but was not fault-injected. Browser verification used local Windows Chrome; other browsers/production hosting were not tested. No live cursors, presence, online counts, chat, sharing UI, execution or deployment were added.

Verified commands/checks:

- `npm.cmd exec -w @codesync/api prisma validate`: schema valid.
- `npm.cmd run db:generate`: Prisma Client generated.
- `npm.cmd exec -w @codesync/api prisma migrate status`: both existing migrations applied; schema up to date.
- `npm.cmd run typecheck` and `npm.cmd run build`: API and frontend pass.
- `npm.cmd test`: **all five integration suites pass**, covering Phase 2/3/4 regression behavior, real concurrent Yjs edits, file isolation, malformed requests, origin/session/access denial, viewer write rejection, automatic/explicit persistence, rename/delete, reconnect and actual API process restart with retained offline edits. Integration fixture files run serially against the shared development database; concurrency is exercised within tests.
- `node apps/web/scripts/check-phase4-browser.mjs`: adapted shared-save regression passes registration/login/dashboard access, workspace/file/folder CRUD, Monaco typing, exact persistence, refresh, rename, viewer read-only mode, keyboard save, switching/reload, stale REST rejection, deletion/cascade and mobile layout.
- `node apps/web/scripts/check-phase5-browser.mjs`: two isolated authenticated Chrome sessions pass bidirectional Monaco editing, concurrent convergence, Ctrl+S, database text/snapshot persistence, both refreshes, remote rename, file separation, offline editing/reconnect replay, unauthorized third-user denial, remote deletion and logout/login.
- `node --check` for the development membership/browser scripts and `git diff --check`: pass.

The Windows sandbox initially prevented the existing process-restart test from accessing user information (`uv_os_get_passwd ENOMEM`); rerunning outside the sandbox passed. An overloaded parallel fixture run encountered a transaction conflict and timeout; serial database fixtures pass. Browser verification also exposed and fixed the local Monaco worker base URL and a premature reload assertion.

### Exact manual Phase 5 browser test

1. Start PostgreSQL and both services with `npm.cmd run dev`. In normal Chrome, register/login as development **User A**, create/open a workspace and create `main.ts` plus `other.ts`. Copy the workspace ID from `/workspace/ID`.
2. In Chrome Incognito, register/login as development **User B**. Use two distinct test accounts. Membership-management UI is deferred; from the repository root, add a legitimate temporary EDITOR membership using the local development database helper:

   ```powershell
   npm.cmd exec -w @codesync/api -- node scripts/phase5-member.mjs WORKSPACE_ID USER_A_EMAIL USER_B_EMAIL add
   ```

   This helper requires the actual owner email, existing users/workspace, refuses changes to the owner, and refuses `NODE_ENV=production`. It creates the normal WorkspaceMember relation; production HTTP/socket authorization is unchanged. Use only the local development database.
3. Open `/workspace/WORKSPACE_ID` as B and select `main.ts`; A selects the same file. Wait for **Connected** in both windows.
4. Type `const a = 1;` as A: B must see it without saving. Type `const b = 2;` as B: A must see it. Edit near the beginning/end simultaneously and confirm identical content in both editors.
5. Press Ctrl+S (Cmd+S on macOS), wait for **Saved**, then refresh A and B separately. Both must reopen the same persisted content. Verify logout/login also preserves it.
6. Switch A to `other.ts`; edit `main.ts` as B. Changes must stay in `main.ts`. Return A to `main.ts` and confirm synchronization. Rename it; both explorers update and code remains.
7. Set B's DevTools Network mode to **Offline**, wait for Offline/Reconnecting, type a small draft, then restore **No throttling**. Wait for Connected/Saved; both editors must converge and refresh must preserve the merged text. While offline with a pending draft, selecting another file must retain the current editor and report the saving error.
8. After Saved, stop/restart the API with Ctrl+C and `npm.cmd run dev -w @codesync/api`; keep browsers open. Confirm reconnect, identical content and refresh persistence.
9. Login as a third account **User C** with no membership. Pasting A's workspace URL must show access denial and no editor. Direct subscribe/update denial is also covered by `realtime.integration.test.ts`; the Phase 4 REST denial console snippet above remains applicable to C.
10. Delete the selected file as A and confirm the dialog. B must show the deletion notice and clear the editor. Refresh and confirm it remains deleted. Phase 6 presence and cursor UI must also clear.
11. Remove the temporary B membership after testing:

   ```powershell
   npm.cmd exec -w @codesync/api -- node scripts/phase5-member.mjs WORKSPACE_ID USER_A_EMAIL USER_B_EMAIL remove
   ```

## Phase 6 presence, live cursors and selections

Presence uses the existing authenticated Socket.IO transport and document authorization, with one in-memory entry per joined socket. Identity and username come from the session; clients supply only a strictly validated file ID and nullable selection. Read-authorized viewers can publish cursors while document writes still require OWNER/EDITOR. Each recipient is reauthorized before receiving presence/cursor data. A 15-second sweep removes expired sessions or memberships changed outside the realtime handlers.

`Collaborators (N)` lists **other users**, excluding the current user and deduplicating people by authenticated user ID. Multiple tabs maintain separate cursors, with a shared user color; closing one connection does not remove another active tab. Closing the last tab removes that user's presence. File switches dispose listeners, decorations and labels and disconnect the old file socket. Disconnect clears the local roster, and reconnect uses the Phase 5 document resynchronization before republishing the retained selection. File deletion clears server presence and file subscriptions immediately and clears the editor UI; later cursor updates for that subscription are rejected.

Cursor/selection anchors are Yjs relative positions in the existing `code` text. Monaco decorations render the remote caret and highlighted range, including reverse selections, with unobtrusive username content widgets. Position mapping accounts for LF versus CRLF display offsets. Names enter DOM `textContent`, not HTML or generated CSS. Colors come from a fixed eight-color palette, with collisions avoided for up to eight concurrently present users and the same user's active tabs sharing a color. Colors remain fixed on active connections; a new session can receive a different available color, and colors repeat beyond eight users.

Cursor updates are coalesced every 80 ms (at most 12.5 Hz), with one request in flight and document updates acknowledged first. The server separately limits presence requests to 25 per second under the existing 100-event socket limit. Cursor events update Monaco directly; React's collaborator list changes only for roster changes, and the workspace does not rerender for cursor movement. No schema, migration or dependency changes were needed.

The installed `y-monaco` Awareness integration was inspected. Its direct path accepts arbitrary client metadata and leaves cursor-selection listeners undisposed. This implementation therefore uses small validated presence events on the existing socket, plus Yjs relative positions and explicitly disposed Monaco listeners. It adds no second transport or independent document synchronization system. Yjs remains responsible for document convergence, and PostgreSQL remains responsible only for durable file content/snapshots.

### Phase 6 automated verification

- `npm.cmd run typecheck`: API and web passed.
- `npm.cmd run build`: API TypeScript and Next.js production builds passed.
- `npm.cmd test`: all six suites passed, including Phase 2 auth/profile/routes, Phase 3 workspace CRUD/permissions/restart, Phase 4 file CRUD/persistence, Phase 5 concurrent Yjs editing/reconnect, Phase 6 presence/cursor validation and lifecycle, and actual API restart with restored presence and cursor updates.
- `node apps/web/scripts/check-phase5-browser.mjs`: the expanded existing regression script passed bidirectional/concurrent editing, Ctrl+S, snapshots/refresh, rename/file isolation, presence, bidirectional cursor labels, forward/reverse selections, positions following inserted text, file-switch cleanup, offline replay/reconnect, deduplicated multiple tabs, close/rejoin, LF-saved snapshots in Windows Monaco without content mutation, unauthorized C, remote deletion with an active selection, responsive layout, and logout/login. It uses isolated headless Chrome profiles; the manual normal/Incognito workflow remains available below.
- `node --check apps/web/scripts/check-phase5-browser.mjs` and `git diff --check`: passed.

Windows sandbox restrictions required running Vitest and headless Chrome outside the sandbox. Initial runs exposed and fixed restored-Yjs-root cursor validation and an assertion landing inside a CRLF newline. Temporary local database failures during concurrent verification were resolved by rerunning; the final API and browser runs passed. No database-outage fault injection or production/multiple-API-instance verification was performed.

### Exact manual Phase 6 browser test

1. Start PostgreSQL and the services with `npm.cmd run dev`. In **normal Chrome**, log in as **User A**, create/open a workspace, and create `main.ts` and `app.ts`. Put several lines of code in `main.ts`, for example `const message = "hello";`, and save. Copy the workspace ID from `/workspace/ID`.
2. In **Chrome Incognito**, log in as a distinct **User B**. Add legitimate development membership from the repository root (replace all placeholders):

   ```powershell
   npm.cmd exec -w @codesync/api -- node scripts/phase5-member.mjs WORKSPACE_ID USER_A_EMAIL USER_B_EMAIL add
   ```

   This existing helper requires the actual owner and existing accounts and refuses production use. It creates ordinary EDITOR membership; it does not bypass HTTP or socket authorization.
3. **A — Presence:** Open `/workspace/WORKSPACE_ID` in both windows, select `main.ts`, and wait for **Connected**. A must see B's username in `Collaborators (1)`, and B must see A's. Neither list includes its own user.
4. **B — Cursor:** Click different lines/columns and use arrow keys in A's editor. B must see A's colored remote caret and label move. Repeat B → A. Keep focus in the source editor; blurring it clears its cursor while preserving file presence.
5. **C — Selection:** As A, drag across several characters and then multiple lines, including `const message = "hello";`. B must see the highlighted remote range. Repeat B → A and drag backward to check reverse selections. Cursor/selection movement alone must leave the file content and Saved state unchanged.
6. **D — Editing regression:** Type as A, then as B, then simultaneously at different places. Both editors must converge. Insert text before a remote selection; its indicator must follow the selected text. Press Ctrl+S, wait for Saved, and refresh each window; content must remain.
7. **E — File switch:** Switch B from `main.ts` to `app.ts`. A's main.ts list must become `Collaborators (0)`, and B's caret/selection/label must disappear. Move B's cursor in app.ts; nothing must appear in A's main.ts. Switch B back to main.ts; presence and cursor updates must return.
8. **F — Disconnect:** Close B's tab. A must lose B's presence and indicators (an abrupt network loss may wait for Socket.IO's heartbeat timeout). Reopen B's Incognito session, log in if needed, and select main.ts; B must appear exactly once. Open a second B tab on the same file: A's person count must remain one. Close one B tab: B must remain present until the last B tab leaves.
9. **G — Reconnect:** After Saved, stop only the API with Ctrl+C and restart with `npm.cmd run dev -w @codesync/api`; leave both browsers open. Wait for Connected: content must remain, each person must appear once, and bidirectional cursors/selections must work. Also test B's DevTools Network **Offline**, then **No throttling**; presence must clear and return, and Phase 5 offline edits must still replay.
10. **H — Unauthorized C:** Use another isolated browser profile as **User C**, without adding membership. Paste `/workspace/WORKSPACE_ID` and the selected `?file=FILE_ID` URL. Expect access denial with no editor, collaborator list, or cursor data. Existing/new API tests also verify direct socket denial.
11. **I — Delete:** Keep B on main.ts with a selection. A deletes main.ts and confirms. B must see the deletion notice, the editor must close, and presence/cursor/selection UI must disappear. Refresh: the file must remain deleted.
12. Remove the temporary B membership when finished:

   ```powershell
   npm.cmd exec -w @codesync/api -- node scripts/phase5-member.mjs WORKSPACE_ID USER_A_EMAIL USER_B_EMAIL remove
   ```

Presence remains single-API-instance ephemeral state. Abrupt disconnect detection follows Socket.IO heartbeat timing; labels can overlap if collaborators share a cursor location. No Phase 7+ functionality is implemented in this checkpoint.

## APIs (authentication/workspaces/files/realtime verified; later phases drafted)

- Auth: `POST /api/auth/register`, `/login`, `/logout`; `GET/PATCH /api/auth/me`.
- Workspaces: `GET/POST /api/workspaces`; `GET/PATCH/DELETE /api/workspaces/:id`.
- Sharing: `POST /api/workspaces/:id/invites`, `POST /api/invites/join`.
- Membership: `PATCH/DELETE /api/workspaces/:id/members/:userId`.
- Files: `GET/POST /api/workspaces/:id/files`; `GET/PATCH/DELETE /api/files/:id`; `POST /api/files/:id/save`.
- Chat: `GET/POST /api/workspaces/:id/messages`.
- Execution: `POST /api/files/:id/run` with optional `stdin`.

REST writes require an `Origin` header matching `WEB_ORIGIN` to prevent cross-site request forgery. Authentication uses credentialed cookies. Validation errors return 400, missing sessions 401, unauthorized actions 403, conflicts 409, expired invitations 410, execution unavailable 503, and execution timeout 504.

Phase 5 Socket.IO requests: `file:subscribe` (`fileId`, optional state vector), `code:update` (`fileId`, incremental bytes), `file:save` (`fileId`), `file:unsubscribe`. File subscription also joins its authorized workspace room. Server events: `code:update`, `file:persisted`, `files:changed`, `file:deleted`, `access:revoked`. Acknowledgements have `{ok:true,data}` or `{ok:false,status,error}`. Phase 6 adds `presence:update` (`fileId`, nullable relative selection), `presence:state` (authorized file roster), and `presence:cursor` (connection-specific selection). No activity/chat request handlers are enabled.

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

Durable CRDT update log, shared document ownership for multiple servers, durable offline editing, shared rate limiting, session cleanup, pagination, accessible application dialogs, secure password reset/email verification, audit logs, execution queues, and cross-browser tests.

## Reference documentation

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [Prisma 6 schema documentation](https://docs.prisma.io/docs/orm/v6/prisma-schema/overview)
- [Yjs Monaco binding](https://github.com/yjs/y-monaco)
- [Yjs incremental document updates and state vectors](https://docs.yjs.dev/api/document-updates)
