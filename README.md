<div align="center">

<img src="https://img.shields.io/badge/PGSA-Studio-0066FF?style=for-the-badge&logo=postgresql&logoColor=white" alt="PGSA Studio" height="40" />

**Ultra-lean PostgreSQL administration studio**

[![Next.js](https://img.shields.io/badge/Next.js-16.4.6-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19.3.0-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-^5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](./LICENSE)

</div>

---

## ✦ Studio Views

| View | Description |
|---|---|
| **Tables** | Spreadsheet grid · server-side pagination (25 / 50 / 100 / 200 rows) · live search · column sort · direct inline cell edit · JSONB viewer · `+ Row` insert · bulk delete |
| **SQL** | CodeMirror 6 editor · schema-aware autocomplete · `⌘↵` execute · `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` · diagnostic presets (Active Backends, Table Sizes, Cache Hit Ratio, Unused Indexes) · local query history |
| **Visualizer** | Interactive ER graph · PK/FK connectors · topological auto-layout · pan / zoom · draggable nodes |
| **Backup & Restore** | `.sql` and `.json` logical backup · `POST /api/backup` download · transactional SQL restore (`BEGIN` / `COMMIT` / `ROLLBACK`) · 25 MB / 100k-row cap |
| **Activity** | `pg_stat_activity` monitor · Cancel / Terminate backends · `pg_stat_user_tables` storage · roles · extensions |
| **⌘K** | Command palette — jump to any table, switch view, or ping `/api/health` |

---

## 🔒 Security

> Zero-fallback design — the app refuses to start if any required env var is missing.

- **Session cookies** — HMAC-SHA256 `HttpOnly` `SameSite=Strict` `pgsa_session`, 8h TTL, `timingSafeEqual` digest, server-side `jti` revocation on sign-out
- **Rate limiting** — per-IP: 5 failures / 5 min with exponential lockout (30s → 60s → 300s); global: 20 failures / 1 min
- **CSRF & export** — `POST`-only `/api/backup`, `sec-fetch-site` + same-host `Origin` check, CSV formula injection neutralization, history wipe on sign-out
- **HTTP headers** — `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`
- **Network isolation** — Docker port bound to `127.0.0.1:3000:3000` (loopback only)

---

## 📦 Stack

| Layer | Packages |
|---|---|
| Framework | `next` 16.4.6 (App Router · standalone · `cacheComponents`) |
| UI Runtime | `react` 19.3.0 · `react-dom` 19.3.0 |
| Language | `typescript ^5` (strict) |
| Styling | `tailwindcss` 4.3.5 · `@tailwindcss/postcss ^4.3.5` · `tw-animate-css ^1.4.0` |
| Components | `shadcn` base-nova · `@base-ui/react ^1.0.0` · `cmdk ^1.1.1` · `sonner ^2.0.8` |
| Motion | `motion ^14.14.0` |
| Icons | `@hugeicons/react ^1.1.10` · `@hugeicons/core-free-icons ^4.4.0` |
| Code Editor | CodeMirror 6 — `@codemirror/{view,state,lang-sql,lang-json,autocomplete,commands,language,search}` · `@lezer/highlight` |
| PostgreSQL | `pg ^8.23.1` · `@types/pg ^8.23.1` |

---

## 🚀 Quick Start

### 1 · Configure environment

```bash
cp .env.example .env
```

```dotenv
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/<database>"
PGSA_USERNAME="<admin-username>"
PGSA_PASSWORD="<strong-password>"

# Behind an HTTPS reverse proxy:
# PGSA_SECURE_COOKIES="true"
```

### 2 · Run with Docker Compose

```bash
docker compose up -d --build
```

PGSA is available at **[http://127.0.0.1:3000](http://127.0.0.1:3000)**
(`compose.yaml` adds `host.docker.internal:host-gateway` so you can point `DATABASE_URL` at a host Postgres instance.)

### 3 · Run locally

```bash
pnpm install --frozen-lockfile
pnpm dev                        # http://localhost:3000
```

**Standalone production build:**

```bash
pnpm build
cp -r .next/static .next/standalone/.next/static
node .next/standalone/server.js
```

---

## 📄 License

MIT © 2026 [Intent Host](https://github.com/intenthost) — see [LICENSE](./LICENSE)
