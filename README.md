# PGSA

Ultra-lean PostgreSQL administration studio built with Next.js 16, React 19, Tailwind CSS v4, CodeMirror 6, shadcn/ui (Base UI), and `pg`.

## Studio Views

- **Tables**: Server-side paginated spreadsheet data grid (`25`/`50`/`100`/`200` rows per page) with live search, column sorting, direct-typing & inline cell editing (`useOptimistic`), JSONB viewer/editor dialog, `+ Row` insertion sheet, and transactional bulk row deletion.
- **SQL**: CodeMirror 6 PostgreSQL editor with schema-aware autocomplete, `⌘↵` / `Ctrl+↵` execution, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` inspection, diagnostic query presets (`Active Backends`, `Table Sizes`, `Unused Indexes`, `Cache Hit Ratio`), and local query history.
- **Visualizer**: Interactive entity-relationship schema graph showing tables, primary/foreign key indicators, column defaults, topological auto-layout, pan/zoom, draggable nodes, and SVG foreign-key connectors.
- **Backup & Restore**: Logical `.sql` (`CREATE SCHEMA`/`SEQUENCE`/`TABLE`/`INDEX` + batched `INSERT`) and `.json` backup preview and `POST /api/backup` download, plus transactional (`BEGIN`/`COMMIT`/`ROLLBACK`) SQL restore.
- **Activity**: Live `pg_stat_activity` backend monitor (`Cancel` / `Terminate`), `pg_stat_user_tables` storage and index breakdown, `pg_roles`, and `pg_extension` inventory.
- **Quick Jump (`⌘K` / `Ctrl+K`)**: Command palette to jump across tables, switch studio views, or inspect `/api/health`.

## Security Highlights

- **Strict zero-fallback configuration**: Requires `DATABASE_URL`, `PGSA_USERNAME`, and `PGSA_PASSWORD` with no hardcoded credentials or default secrets.
- **Hardened session cookies**: HMAC-SHA256 signed `HttpOnly`, `SameSite=Strict` `pgsa_session` cookie (8-hour TTL) with `timingSafeEqual` digest checks and server-side `jti` revocation on sign-out.
- **Login rate limiting**: Dual per-IP (5 failures / 5 min with exponential `30s`/`60s`/`300s` lockout) and global (20 failures / 1 min with `60s` cooldown) brute-force protection.
- **CSRF & export safeguards**: `POST`-only `/api/backup` enforcing `sec-fetch-site` and same-host `origin` validation, 25 MB / 100,000-row backup caps, CSV formula injection neutralization, and SQL query history cleanup on sign-out.
- **HTTP security headers & isolation**: `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, minimal unauthenticated `/api/health` responses, and loopback-only Docker port binding (`127.0.0.1:3000:3000`).

## Stack

| Layer | Packages |
| --- | --- |
| Framework & Runtime | `next` `16.4.6` (App Router, standalone, `cacheComponents`), `react` `19.3.0`, `react-dom` `19.3.0` |
| Language & Styling | `typescript` `^5`, `tailwindcss` `4.3.5`, `@tailwindcss/postcss` `^4.3.5`, `tw-animate-css` `^1.4.0` |
| UI & Motion | `shadcn` (`base-nova`, `@base-ui/react` `^1.9.0`), `cmdk` `^1.1.1`, `sonner` `^2.0.8`, `motion` `^14.14.0` |
| Icons | `@hugeicons/react` `^1.1.10`, `@hugeicons/core-free-icons` `^4.4.0` |
| Code Editor | Modular CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-sql`, `@codemirror/lang-json`, `@codemirror/autocomplete`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/search`, `@lezer/highlight`) |
| PostgreSQL Driver | `pg` `^8.23.1`, `@types/pg` `^8.23.1` |

## Quick Start

### 1. Configure Environment

Copy `.env.example` to `.env` and populate all three required variables:

```bash
cp .env.example .env
```

```dotenv
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/<database>"
PGSA_USERNAME="<admin-username>"
PGSA_PASSWORD="<strong-password>"
```

When running behind an HTTPS reverse proxy in production, set `PGSA_SECURE_COOKIES="true"`.

### 2. Run with Docker Compose

```bash
docker compose up -d --build
```

PGSA binds to `http://127.0.0.1:3000` (`compose.yaml` includes `host.docker.internal:host-gateway` for connecting to a host PostgreSQL instance).

### 3. Run Locally

```bash
pnpm install --frozen-lockfile
pnpm dev
```

For a production build:

```bash
pnpm build
pnpm start
```

## License

Licensed under the [MIT License](./LICENSE).
