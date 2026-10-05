# CodeSync

A portfolio project for a real-time collaborative development workspace. Requested stack: Next.js, React, TypeScript, Tailwind CSS, Monaco Editor, Express, Socket.IO, Yjs, PostgreSQL, and Prisma.

## Current checkpoint

**Phase 1 implementation is ready for verification.** The repository includes the monorepo setup, responsive landing page, relational Prisma schema, environment examples, and local PostgreSQL configuration. Authentication, workspace, and collaboration backend modules were drafted before the phased requirement arrived; they are **unverified scaffolding**, not completed product features. The login, registration, and dashboard routes explain this development status rather than using fake accounts or hardcoded workspace data.

Do not present this checkpoint as a finished collaborative editor. No cloud services have been provisioned or deployed.

## Development plan

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Project setup, database, landing page | Implemented; dependency/build/database verification pending |
| 2 | Authentication, profile, dashboard | Backend draft; frontend pending |
| 3 | Workspace creation and persistence | Backend draft; frontend pending |
| 4 | Monaco integration and file explorer | File API draft; frontend pending |
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
    src/app.ts               Express REST endpoints (draft)
    src/realtime.ts          Socket.IO events (draft)
    src/documents.ts         Yjs document lifecycle (draft)
    src/execution.ts         Isolated runner adapter (draft)
```

The API runs separately from Next.js so a persistent service owns WebSocket connections. Authentication uses random opaque session cookies, stores only SHA-256 session token hashes, hashes passwords with bcrypt, and limits sessions to seven days. PostgreSQL remains the source of truth for users, workspace membership, files, and chat.

The collaboration design uses incremental Yjs updates rather than replacing a file on every keystroke. The backend loads an active file lazily, persists its CRDT snapshot and readable content after a 1.5-second debounce, and supports state-vector synchronization. Explicit saves flush snapshots. This initial design requires **one backend instance**: horizontal scaling needs document ownership or a shared collaboration persistence design. Debounced saves can lose recent updates on a hard process crash; a durable update log is a future improvement.

Draft socket payloads carry validated positions for cursors; relative CRDT cursor positions should be implemented before promising stable cursor tracking under concurrent edits. File deletion/update concurrency and persistence failure handling need integration tests and further hardening.

## Database schema

| Entity | Purpose |
| --- | --- |
| User | Username, unique email, password hash, optional avatar, timestamps |
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

If using a local/cloud PostgreSQL installation instead of Docker, set `DATABASE_URL` accordingly and omit the Docker command. An initial SQL migration is committed; it has not been applied in this environment. `npm run db:migrate` creates subsequent development migrations; check generated SQL into version control. Production uses `npm run db:deploy -w @codesync/api`, never `migrate dev`.

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

## Planned APIs (draft implementation)

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
