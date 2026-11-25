import { Suspense } from "react";
import { io } from "next/cache";
import { PgsaWorkbench, type ConnectionMeta } from "@/components/pgsa-workbench";
import { requireSession } from "@/lib/auth";
import {
  browseTableRows,
  executePostgresQuery,
  fetchSchemaCatalog,
} from "@/lib/db";
import { getEnvConfig, getEnvStatus } from "@/lib/env";
import type { QueryExecutionResult, QueryTab, TableSchema } from "@/types/postgres";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function extractSafeConnectionMeta(sessionUsername: string): ConnectionMeta {
  const meta: ConnectionMeta = {
    sessionUser: sessionUsername,
  };

  if (!getEnvStatus().configured) {
    return meta;
  }

  try {
    const { databaseUrl } = getEnvConfig();
    const parsed = new URL(databaseUrl);
    const dbName = parsed.pathname.replace(/^\/+/, "");

    if (parsed.hostname) {
      meta.host = parsed.hostname;
    }
    if (parsed.port) {
      meta.port = parsed.port;
    }
    if (dbName) {
      meta.database = decodeURIComponent(dbName);
    }
    const sslMode = parsed.searchParams.get("sslmode");
    if (sslMode) {
      meta.sslMode = sslMode;
    }
  } catch {
    // Keep partial metadata if DATABASE_URL is not a standard URL
  }

  return meta;
}

function formatPgVersionLabel(rawVersion: unknown): string | undefined {
  if (typeof rawVersion !== "string" || !rawVersion.trim()) {
    return undefined;
  }
  const match = /PostgreSQL\s+([^\s,]+)/i.exec(rawVersion);
  if (match?.[1]) {
    return `PostgreSQL ${match[1]}`;
  }
  return rawVersion.split(",")[0]?.trim();
}

function WorkbenchFallback() {
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
        <div className="flex items-center gap-2.5">
          <div className="size-7 animate-pulse rounded-md bg-muted" />
          <span className="text-sm font-semibold tracking-tight text-foreground">
            PGSA
          </span>
          <span className="text-sm text-zinc-300 select-none">/</span>
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        </div>

        <div className="hidden items-center gap-3 sm:flex">
          <div className="h-5 w-14 animate-pulse rounded bg-muted" />
          <div className="h-5 w-12 animate-pulse rounded bg-muted" />
          <div className="h-5 w-18 animate-pulse rounded bg-muted" />
          <div className="h-5 w-14 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
        </div>

        <div className="flex items-center gap-2">
          <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
          <div className="h-7 w-16 animate-pulse rounded-md bg-muted" />
          <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-[#fafafa] md:flex">
          <div className="border-b border-border p-2">
            <div className="h-7 w-full animate-pulse rounded-md bg-zinc-200/70" />
          </div>
          <div className="flex flex-1 flex-col gap-1.5 p-2">
            <div className="h-7 animate-pulse rounded-md bg-zinc-200/60" />
            <div className="h-7 animate-pulse rounded-md bg-zinc-200/50" />
            <div className="h-7 animate-pulse rounded-md bg-zinc-200/50" />
            <div className="h-7 animate-pulse rounded-md bg-zinc-200/40" />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
            <div className="h-4 w-44 animate-pulse rounded bg-muted" />
            <div className="flex items-center gap-2">
              <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
              <div className="h-7 w-16 animate-pulse rounded-md bg-muted" />
              <div className="h-7 w-16 animate-pulse rounded-md bg-muted" />
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-2 p-3">
            <div className="h-8 animate-pulse rounded bg-muted/80" />
            <div className="h-8 animate-pulse rounded bg-muted/50" />
            <div className="h-8 animate-pulse rounded bg-muted/50" />
            <div className="h-8 animate-pulse rounded bg-muted/40" />
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              Loading PostgreSQL workspace…
            </div>
          </div>

          <div className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-[#fafafa] px-3">
            <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-200/70" />
            <div className="h-5 w-44 animate-pulse rounded bg-zinc-200/70" />
          </div>
        </main>
      </div>
    </div>
  );
}

async function WorkbenchLoader() {
  await io();

  const session = await requireSession();
  const connectionMeta = extractSafeConnectionMeta(session.username);
  const catalogResult = await fetchSchemaCatalog();

  const sessionInfoSql =
    "SELECT version(), current_database(), current_user;";

  if (catalogResult.ok && catalogResult.tables.length > 0) {
    const firstTable = catalogResult.tables[0];
    const initialSql = `SELECT * FROM ${quoteIdentifier(firstTable.schema)}.${quoteIdentifier(firstTable.name)} LIMIT 50;`;

    const [initialResult, serverInfoResult] = await Promise.all([
      browseTableRows({
        schema: firstTable.schema,
        table: firstTable.name,
        page: 1,
        pageSize: 50,
      }),
      executePostgresQuery(sessionInfoSql),
    ]);

    const syncedCatalog: TableSchema[] = catalogResult.tables.map((tbl, idx) =>
      idx === 0 && initialResult.totalRows !== undefined
        ? { ...tbl, rowEstimate: initialResult.totalRows }
        : tbl
    );

    const infoRow = serverInfoResult.ok ? serverInfoResult.rows[0] : undefined;
    if (infoRow) {
      if (typeof infoRow.current_database === "string") {
        connectionMeta.database = infoRow.current_database;
      }
      if (typeof infoRow.current_user === "string") {
        connectionMeta.dbUser = infoRow.current_user;
      }
      const pgVer = formatPgVersionLabel(infoRow.version);
      if (pgVer) {
        connectionMeta.pgVersion = pgVer;
      }
    }

    const initialTabs: QueryTab[] = [
      {
        id: "tab-1",
        title: `${firstTable.name}.sql`,
        sql: initialSql,
        isDirty: false,
      },
    ];

    return (
      <PgsaWorkbench
        initialTabs={initialTabs}
        schemaCatalog={syncedCatalog}
        initialResult={initialResult}
        connectionMeta={connectionMeta}
      />
    );
  }

  if (catalogResult.ok) {
    const initialResult = await executePostgresQuery(sessionInfoSql);
    const infoRow = initialResult.ok ? initialResult.rows[0] : undefined;
    if (infoRow) {
      if (typeof infoRow.current_database === "string") {
        connectionMeta.database = infoRow.current_database;
      }
      if (typeof infoRow.current_user === "string") {
        connectionMeta.dbUser = infoRow.current_user;
      }
      const pgVer = formatPgVersionLabel(infoRow.version);
      if (pgVer) {
        connectionMeta.pgVersion = pgVer;
      }
    }

    const initialTabs: QueryTab[] = [
      {
        id: "tab-1",
        title: "session_info.sql",
        sql: sessionInfoSql,
        isDirty: false,
      },
    ];

    return (
      <PgsaWorkbench
        initialTabs={initialTabs}
        schemaCatalog={[]}
        initialResult={initialResult}
        connectionMeta={connectionMeta}
      />
    );
  }

  const emptyResult: QueryExecutionResult = {
    ok: true,
    columns: [],
    rows: [],
    rowCount: 0,
    durationMs: 0,
    command: "EMPTY",
  };

  const initialTabs: QueryTab[] = [
    {
      id: "tab-1",
      title: "query_1.sql",
      sql: sessionInfoSql,
      isDirty: false,
    },
  ];

  return (
    <PgsaWorkbench
      initialTabs={initialTabs}
      schemaCatalog={[]}
      initialResult={emptyResult}
      catalogError={
        catalogResult.error ??
        "Unable to load PostgreSQL schema catalog. Check DATABASE_URL and database connectivity."
      }
      connectionMeta={connectionMeta}
    />
  );
}

export default function Home() {
  return (
    <Suspense fallback={<WorkbenchFallback />}>
      <WorkbenchLoader />
    </Suspense>
  );
}
