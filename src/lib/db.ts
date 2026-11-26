import {
  Pool,
  escapeIdentifier,
  escapeLiteral,
  type FieldDef,
  type QueryResult,
} from "pg";
import { getEnvConfig, getEnvStatus } from "@/lib/env";
import type {
  ActivityAndStatsPayload,
  ActivityProcess,
  BackupOptions,
  BackupResult,
  ForeignKeyEdge,
  PgExtensionInfo,
  PgRoleInfo,
  PostgresColumn,
  PostgresDataType,
  PostgresJsonObject,
  PostgresRow,
  PostgresValue,
  QueryExecutionResult,
  RestoreResult,
  SchemaGraphResult,
  SqlCommandTag,
  TableColumnDetail,
  TableNode,
  TableSchema,
  TableStorageStat,
} from "@/types/postgres";

const MAX_RESULT_ROWS = 1000;
const MAX_DELETE_BATCH = 1000;
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_BACKUP_ROWS = 100_000;
const INSERT_BATCH_SIZE = 100;
const POOL_KEY = Symbol.for("pgsa.pg.pool");

class BackupLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupLimitError";
  }
}

interface CachedPoolEntry {
  connectionString: string;
  pool: Pool;
}

const globalForPg = globalThis as typeof globalThis & {
  [POOL_KEY]?: CachedPoolEntry;
};

const OID_TO_TYPE: Record<number, PostgresDataType> = {
  16: "bool",
  17: "bytea",
  18: "char",
  20: "int8",
  21: "int2",
  23: "int4",
  25: "text",
  26: "oid",
  114: "json",
  142: "xml",
  650: "cidr",
  700: "float4",
  701: "float8",
  790: "money",
  829: "macaddr",
  869: "inet",
  1000: "bool[]",
  1005: "int2[]",
  1007: "int4[]",
  1009: "text[]",
  1014: "bpchar[]",
  1015: "varchar[]",
  1016: "int8[]",
  1021: "float4[]",
  1022: "float8[]",
  1042: "bpchar",
  1043: "varchar",
  1082: "date",
  1083: "time",
  1114: "timestamp",
  1184: "timestamptz",
  1185: "timestamptz[]",
  1186: "interval",
  1231: "numeric[]",
  1266: "timetz",
  1700: "numeric",
  2950: "uuid",
  2951: "uuid[]",
  3802: "jsonb",
  3807: "jsonb[]",
};

function getPool(): Pool {
  const { databaseUrl } = getEnvConfig();
  const cached = globalForPg[POOL_KEY];

  if (cached && cached.connectionString === databaseUrl) {
    return cached.pool;
  }

  if (cached) {
    void cached.pool.end().catch(() => undefined);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 4_000,
    statement_timeout: 30_000,
  });

  pool.on("error", (err) => {
    console.error("[pgsa-db] idle pool client error:", err.message);
  });

  globalForPg[POOL_KEY] = {
    connectionString: databaseUrl,
    pool,
  };

  return pool;
}

function formatPgError(error: unknown): string {
  if (error instanceof Error) {
    const pgErr = error as Error & {
      code?: string;
      detail?: string;
      hint?: string;
    };
    const parts = [pgErr.message];
    if (pgErr.code) {
      parts[0] = `[${pgErr.code}] ${pgErr.message}`;
    }
    if (pgErr.detail) {
      parts.push(pgErr.detail);
    }
    if (pgErr.hint) {
      parts.push(`Hint: ${pgErr.hint}`);
    }
    return parts.join(" — ");
  }
  return "Unknown PostgreSQL error.";
}

function formatUdtName(udtName: string): PostgresDataType {
  if (udtName.startsWith("_")) {
    return `${udtName.slice(1)}[]`;
  }
  return udtName;
}

function formatPgDateLocal(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePostgresValue(
  value: unknown,
  dataTypeID?: number
): PostgresValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return String(value);
    }
    if (dataTypeID === 1082) {
      return formatPgDateLocal(value);
    }
    return value.toISOString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `\\x${Buffer.from(value).toString("hex")}`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizePostgresValue(item));
  }

  if (typeof value === "object") {
    const withToPostgres = value as { toPostgres?: () => string };
    if (typeof withToPostgres.toPostgres === "function") {
      return withToPostgres.toPostgres();
    }

    const plain: PostgresJsonObject = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      plain[k] = normalizePostgresValue(v);
    }
    return plain;
  }

  return String(value);
}

function normalizeRow(
  rawRow: Record<string, unknown>,
  fields?: FieldDef[]
): PostgresRow {
  const fieldOidByName =
    fields && fields.length > 0
      ? new Map(fields.map((f) => [f.name, f.dataTypeID]))
      : null;

  const row: PostgresRow = {};
  for (const [key, val] of Object.entries(rawRow)) {
    row[key] = normalizePostgresValue(val, fieldOidByName?.get(key));
  }
  return row;
}

function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      out += " ";
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += " ";
      continue;
    }

    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      out += " '' ";
      continue;
    }

    if (ch === "$") {
      const rest = sql.slice(i);
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx !== -1) {
          i = closeIdx + tag.length;
          out += " '' ";
          continue;
        }
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function splitTopLevelSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... \n
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    // Block comment: /* ... */ (supports PostgreSQL nested comments)
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Double-quoted identifier: "..."
    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Escape string literal: E'...' or e'...'
    if (
      (ch === "E" || ch === "e") &&
      next === "'" &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))
    ) {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Standard single-quoted string literal: '...'
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Dollar-quoted literal: $tag$...$tag$
    if (ch === "$") {
      const rest = sql.slice(i);
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx !== -1) {
          i = closeIdx + tag.length;
          continue;
        }
      }
    }

    // Statement terminator
    if (ch === ";") {
      const raw = sql.slice(start, i).trim();
      if (stripSqlCommentsAndLiterals(raw).trim().length > 0) {
        statements.push(raw);
      }
      i += 1;
      start = i;
      continue;
    }

    i += 1;
  }

  const tail = sql.slice(start).trim();
  if (stripSqlCommentsAndLiterals(tail).trim().length > 0) {
    statements.push(tail);
  }

  return statements;
}

function isSimpleSingleTableSelect(sql: string): boolean {
  const stripped = stripSqlCommentsAndLiterals(sql).trim();
  const withoutTrailingSemi = stripped.replace(/;+\s*$/, "").trim();
  if (!withoutTrailingSemi || withoutTrailingSemi.includes(";")) {
    return false;
  }

  if (!/^SELECT\b/i.test(withoutTrailingSemi)) {
    return false;
  }

  if (
    /\b(JOIN|UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|DISTINCT|WINDOW|FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|INTO)\b/i.test(
      withoutTrailingSemi
    )
  ) {
    return false;
  }

  return true;
}

async function resolveFieldMetadata(
  pool: Pool,
  fields: FieldDef[],
  allowSingleTableEdit: boolean
): Promise<{
  columns: PostgresColumn[];
  sourceTable?: string;
  primaryKeyColumns?: string[];
  editable: boolean;
}> {
  if (fields.length === 0) {
    return { columns: [], editable: false };
  }

  const unknownOids = Array.from(
    new Set(
      fields
        .map((f) => f.dataTypeID)
        .filter((oid) => oid > 0 && !(oid in OID_TO_TYPE))
    )
  );

  const tableIds = Array.from(
    new Set(fields.map((f) => f.tableID).filter((id) => id > 0))
  );

  const customTypes = new Map<number, PostgresDataType>();
  const attrMap = new Map<string, { attname: string; nullable: boolean }>();

  let sourceTable: string | undefined;
  let primaryKeyColumns: string[] | undefined;
  let editable = false;

  if (unknownOids.length > 0) {
    try {
      const typeRes = await pool.query<{ oid: number; typname: string }>(
        "SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])",
        [unknownOids]
      );
      for (const row of typeRes.rows) {
        customTypes.set(row.oid, formatUdtName(row.typname));
      }
    } catch {
      // Keep OID string formatting if catalog lookup fails
    }
  }

  if (tableIds.length > 0) {
    try {
      const attrRes = await pool.query<{
        attrelid: number;
        attnum: number;
        attname: string;
        attnotnull: boolean;
      }>(
        "SELECT attrelid::int AS attrelid, attnum::int AS attnum, attname, attnotnull FROM pg_attribute WHERE attrelid = ANY($1::oid[]) AND attnum > 0 AND NOT attisdropped",
        [tableIds]
      );
      for (const row of attrRes.rows) {
        attrMap.set(`${row.attrelid}:${row.attnum}`, {
          attname: row.attname,
          nullable: !row.attnotnull,
        });
      }
    } catch {
      // Non-fatal: columns default to nullable: true
    }
  }

  if (allowSingleTableEdit && tableIds.length === 1) {
    const singleTableId = tableIds[0];
    try {
      const tableMetaRes = await pool.query<{
        schema_name: string;
        table_name: string;
        relkind: string;
      }>(
        `SELECT n.nspname AS schema_name, c.relname AS table_name, c.relkind::text AS relkind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.oid = $1::oid`,
        [singleTableId]
      );

      const meta = tableMetaRes.rows[0];
      if (meta && (meta.relkind === "r" || meta.relkind === "p")) {
        sourceTable = `${meta.schema_name}.${meta.table_name}`;

        const pkRes = await pool.query<{
          attnum: number;
          attname: string;
        }>(
          `SELECT a.attnum::int AS attnum, a.attname
           FROM pg_constraint con
           CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum AND NOT a.attisdropped
           WHERE con.conrelid = $1::oid AND con.contype = 'p'
           ORDER BY k.ord ASC`,
          [singleTableId]
        );

        if (pkRes.rows.length > 0) {
          primaryKeyColumns = pkRes.rows.map((r) => r.attname);
          editable = pkRes.rows.every((pk) =>
            fields.some(
              (f) =>
                f.tableID === singleTableId &&
                f.columnID === pk.attnum &&
                f.name === pk.attname
            )
          );
        } else {
          primaryKeyColumns = [];
        }
      }
    } catch {
      // Non-fatal: editing remains disabled if catalog inspection fails
    }
  }

  const columns: PostgresColumn[] = fields.map((field) => {
    const dataType =
      OID_TO_TYPE[field.dataTypeID] ??
      customTypes.get(field.dataTypeID) ??
      (field.dataTypeID > 0 ? `oid:${field.dataTypeID}` : "unknown");

    const attr =
      field.tableID > 0 && field.columnID > 0
        ? attrMap.get(`${field.tableID}:${field.columnID}`)
        : undefined;

    return {
      name: field.name,
      dataType,
      oid: field.dataTypeID,
      nullable: attr ? attr.nullable : true,
    };
  });

  return {
    columns,
    sourceTable,
    primaryKeyColumns,
    editable,
  };
}

const EXACT_COUNT_MAX_ESTIMATE = 250_000;
const EXACT_COUNT_CONCURRENCY = 6;

interface CountCandidate {
  schema: string;
  name: string;
  estimate: number;
  isView: boolean;
}

/**
 * Compute exact row counts for base tables within a safe size threshold so
 * sidebar and visualizer totals reflect real database state immediately on
 * connect rather than stale planner estimates.
 */
async function resolveExactTableCounts(
  pool: Pool,
  entries: CountCandidate[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const targets: CountCandidate[] = [];

  for (const entry of entries) {
    const key = `${entry.schema}.${entry.name}`;
    counts.set(key, entry.estimate);
    if (!entry.isView && entry.estimate <= EXACT_COUNT_MAX_ESTIMATE) {
      targets.push(entry);
    }
  }

  if (targets.length === 0) return counts;

  let cursor = 0;
  const workerCount = Math.min(EXACT_COUNT_CONCURRENCY, targets.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < targets.length) {
        const current = targets[cursor];
        cursor += 1;
        if (!current) break;

        const key = `${current.schema}.${current.name}`;
        try {
          const qualified = `${escapeIdentifier(current.schema)}.${escapeIdentifier(current.name)}`;
          const res = await pool.query<{ cnt: string }>(
            `SELECT COUNT(*)::bigint AS cnt FROM ${qualified}`
          );
          const parsed = Number(res.rows[0]?.cnt);
          if (Number.isFinite(parsed) && parsed >= 0) {
            counts.set(key, parsed);
          }
        } catch {
          // Keep planner estimate if table is unreadable or times out.
        }
      }
    })
  );

  return counts;
}

export async function fetchSchemaCatalog(): Promise<{
  ok: boolean;
  tables: TableSchema[];
  error?: string;
}> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      tables: [],
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  try {
    const pool = getPool();
    const [tablesRes, columnsRes, pkRes] = await Promise.all([
      pool.query<{
        schema_name: string;
        table_name: string;
        table_type: string;
        row_estimate: string;
      }>(`
        SELECT
          t.table_schema AS schema_name,
          t.table_name AS table_name,
          t.table_type AS table_type,
          CASE
            WHEN c.oid IS NULL THEN 0
            ELSE GREATEST(
              COALESCE(c.reltuples, 0)::bigint,
              COALESCE(pg_stat_get_live_tuples(c.oid), 0),
              0
            )
          END AS row_estimate
        FROM information_schema.tables t
        LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
        WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND t.table_schema NOT LIKE 'pg_toast%'
          AND t.table_type IN ('BASE TABLE', 'VIEW')
        ORDER BY
          CASE WHEN t.table_schema = 'public' THEN 0 ELSE 1 END,
          t.table_schema ASC,
          t.table_name ASC
      `),
      pool.query<{
        schema_name: string;
        table_name: string;
        column_name: string;
        udt_name: string;
        is_nullable: string;
        oid: number;
      }>(`
        SELECT
          col.table_schema AS schema_name,
          col.table_name AS table_name,
          col.column_name AS column_name,
          col.udt_name AS udt_name,
          col.is_nullable AS is_nullable,
          COALESCE(a.atttypid, 0)::int AS oid
        FROM information_schema.columns col
        LEFT JOIN pg_namespace n ON n.nspname = col.table_schema
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = col.table_name
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = col.column_name AND NOT a.attisdropped
        WHERE col.table_schema NOT IN ('pg_catalog', 'information_schema')
          AND col.table_schema NOT LIKE 'pg_toast%'
        ORDER BY col.table_schema, col.table_name, col.ordinal_position ASC
      `),
      pool.query<{
        schema_name: string;
        table_name: string;
        column_name: string;
      }>(`
        SELECT
          n.nspname AS schema_name,
          c.relname AS table_name,
          a.attname AS column_name
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index idx ON idx.indexrelid = con.conindid
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND NOT a.attisdropped
        WHERE con.contype = 'p'
          AND idx.indisprimary
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname, k.ord ASC
      `),
    ]);

    const columnsByTable = new Map<string, PostgresColumn[]>();
    for (const colRow of columnsRes.rows) {
      const key = `${colRow.schema_name}.${colRow.table_name}`;
      const list = columnsByTable.get(key) ?? [];
      const oid = Number(colRow.oid) || 0;
      list.push({
        name: colRow.column_name,
        dataType: OID_TO_TYPE[oid] ?? formatUdtName(colRow.udt_name),
        oid,
        nullable: colRow.is_nullable === "YES",
      });
      columnsByTable.set(key, list);
    }

    const pkByTable = new Map<string, string[]>();
    for (const pkRow of pkRes.rows) {
      const key = `${pkRow.schema_name}.${pkRow.table_name}`;
      const list = pkByTable.get(key) ?? [];
      list.push(pkRow.column_name);
      pkByTable.set(key, list);
    }

    const exactCounts = await resolveExactTableCounts(
      pool,
      tablesRes.rows.map((tbl) => ({
        schema: tbl.schema_name,
        name: tbl.table_name,
        estimate: Number(tbl.row_estimate) || 0,
        isView: tbl.table_type === "VIEW",
      }))
    );

    const tables: TableSchema[] = tablesRes.rows.map((tbl) => {
      const key = `${tbl.schema_name}.${tbl.table_name}`;
      return {
        schema: tbl.schema_name,
        name: tbl.table_name,
        rowEstimate: exactCounts.get(key) ?? (Number(tbl.row_estimate) || 0),
        primaryKeyColumns: pkByTable.get(key) ?? [],
        columns: columnsByTable.get(key) ?? [],
      };
    });

    return { ok: true, tables };
  } catch (error) {
    return {
      ok: false,
      tables: [],
      error: formatPgError(error),
    };
  }
}

function fkActionLabel(code: string): string {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "NO ACTION";
  }
}

export async function fetchSchemaGraph(): Promise<SchemaGraphResult> {
  const emptyGraph = { tables: [], edges: [], schemas: [] };
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      graph: emptyGraph,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  try {
    const pool = getPool();
    const [tablesRes, colsRes, pkRes, fkRes] = await Promise.all([
      pool.query<{
        schema_name: string;
        table_name: string;
        relkind: string;
        row_estimate: string;
      }>(`
        SELECT
          n.nspname AS schema_name,
          c.relname AS table_name,
          c.relkind::text AS relkind,
          GREATEST(
            COALESCE(c.reltuples, 0)::bigint,
            COALESCE(pg_stat_get_live_tuples(c.oid), 0),
            0
          ) AS row_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
          AND NOT c.relispartition
          AND c.relkind IN ('r', 'p', 'v')
        ORDER BY
          CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END,
          n.nspname ASC,
          c.relname ASC
      `),
      pool.query<{
        schema_name: string;
        table_name: string;
        column_name: string;
        udt_name: string;
        oid: number;
        nullable: boolean;
        default_expr: string | null;
      }>(`
        SELECT
          n.nspname AS schema_name,
          c.relname AS table_name,
          a.attname AS column_name,
          t.typname AS udt_name,
          a.atttypid::int AS oid,
          (NOT a.attnotnull) AS nullable,
          pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND NOT c.relispartition
          AND c.relkind IN ('r', 'p', 'v')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
        ORDER BY n.nspname, c.relname, a.attnum ASC
      `),
      pool.query<{
        schema_name: string;
        table_name: string;
        column_name: string;
      }>(`
        SELECT
          n.nspname AS schema_name,
          c.relname AS table_name,
          a.attname AS column_name
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND NOT a.attisdropped
        WHERE con.contype = 'p'
          AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
        ORDER BY n.nspname, c.relname, k.ord ASC
      `),
      pool.query<{
        constraint_oid: number;
        constraint_name: string;
        source_schema: string;
        source_table: string;
        source_column: string;
        target_schema: string;
        target_table: string;
        target_column: string;
        on_update_code: string;
        on_delete_code: string;
      }>(`
        SELECT
          con.oid::int AS constraint_oid,
          con.conname AS constraint_name,
          sn.nspname AS source_schema,
          sc.relname AS source_table,
          sa.attname AS source_column,
          tn.nspname AS target_schema,
          tc.relname AS target_table,
          ta.attname AS target_column,
          con.confupdtype::text AS on_update_code,
          con.confdeltype::text AS on_delete_code
        FROM pg_constraint con
        JOIN pg_class sc ON sc.oid = con.conrelid
        JOIN pg_namespace sn ON sn.oid = sc.relnamespace
        JOIN pg_class tc ON tc.oid = con.confrelid
        JOIN pg_namespace tn ON tn.oid = tc.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(src_attnum, tgt_attnum, ord)
        JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.src_attnum AND NOT sa.attisdropped
        JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.tgt_attnum AND NOT ta.attisdropped
        WHERE con.contype = 'f'
          AND NOT sc.relispartition
          AND sn.nspname NOT IN ('pg_catalog', 'information_schema')
          AND sn.nspname NOT LIKE 'pg_toast%'
          AND sn.nspname NOT LIKE 'pg_temp_%'
        ORDER BY sn.nspname, sc.relname, con.conname, k.ord ASC
      `),
    ]);

    const pkMap = new Map<string, string[]>();
    const pkSetMap = new Map<string, Set<string>>();
    for (const row of pkRes.rows) {
      const fqn = `${row.schema_name}.${row.table_name}`;
      const list = pkMap.get(fqn) ?? [];
      list.push(row.column_name);
      pkMap.set(fqn, list);

      const set = pkSetMap.get(fqn) ?? new Set<string>();
      set.add(row.column_name);
      pkSetMap.set(fqn, set);
    }

    const edgeByOid = new Map<number, ForeignKeyEdge>();
    const fkLookupByCol = new Map<
      string,
      { schema: string; table: string; column: string }
    >();

    for (const row of fkRes.rows) {
      let edge = edgeByOid.get(row.constraint_oid);
      if (!edge) {
        edge = {
          constraintName: row.constraint_name,
          sourceSchema: row.source_schema,
          sourceTable: row.source_table,
          sourceColumns: [],
          targetSchema: row.target_schema,
          targetTable: row.target_table,
          targetColumns: [],
          onUpdate: fkActionLabel(row.on_update_code),
          onDelete: fkActionLabel(row.on_delete_code),
        };
        edgeByOid.set(row.constraint_oid, edge);
      }
      edge.sourceColumns.push(row.source_column);
      edge.targetColumns.push(row.target_column);

      const colKey = `${row.source_schema}.${row.source_table}.${row.source_column}`;
      if (!fkLookupByCol.has(colKey)) {
        fkLookupByCol.set(colKey, {
          schema: row.target_schema,
          table: row.target_table,
          column: row.target_column,
        });
      }
    }

    const colsByTable = new Map<string, TableColumnDetail[]>();
    for (const row of colsRes.rows) {
      const fqn = `${row.schema_name}.${row.table_name}`;
      const pkSet = pkSetMap.get(fqn);
      const foreignTarget = fkLookupByCol.get(`${fqn}.${row.column_name}`);
      const oid = Number(row.oid) || 0;

      const detail: TableColumnDetail = {
        name: row.column_name,
        dataType: OID_TO_TYPE[oid] ?? formatUdtName(row.udt_name),
        nullable: row.nullable,
        isPrimaryKey: Boolean(pkSet?.has(row.column_name)),
        isForeignKey: Boolean(foreignTarget),
        ...(row.default_expr !== null ? { defaultValue: row.default_expr } : {}),
        ...(foreignTarget ? { foreignTarget } : {}),
      };

      const list = colsByTable.get(fqn) ?? [];
      list.push(detail);
      colsByTable.set(fqn, list);
    }

    const exactCounts = await resolveExactTableCounts(
      pool,
      tablesRes.rows.map((tbl) => ({
        schema: tbl.schema_name,
        name: tbl.table_name,
        estimate: Number(tbl.row_estimate) || 0,
        isView: tbl.relkind === "v",
      }))
    );

    const tables: TableNode[] = tablesRes.rows.map((tbl) => {
      const fqn = `${tbl.schema_name}.${tbl.table_name}`;
      return {
        schema: tbl.schema_name,
        name: tbl.table_name,
        rowEstimate: exactCounts.get(fqn) ?? (Number(tbl.row_estimate) || 0),
        primaryKeyColumns: pkMap.get(fqn) ?? [],
        columns: colsByTable.get(fqn) ?? [],
      };
    });

    const schemas = Array.from(new Set(tables.map((t) => t.schema)));

    return {
      ok: true,
      graph: {
        tables,
        edges: Array.from(edgeByOid.values()),
        schemas,
      },
    };
  } catch (error) {
    return {
      ok: false,
      graph: emptyGraph,
      error: formatPgError(error),
    };
  }
}

export async function executePostgresQuery(
  sql: string
): Promise<QueryExecutionResult> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "ERROR",
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const trimmed = sql.trim();
  if (!trimmed) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "EMPTY",
      error: "SQL query is empty.",
    };
  }

  const startedAt = performance.now();

  try {
    const pool = getPool();
    const rawResult = (await pool.query(trimmed)) as
      | QueryResult
      | QueryResult[];
    const durationMs = Math.max(
      0,
      Math.round((performance.now() - startedAt) * 100) / 100
    );

    const resultsArray = Array.isArray(rawResult) ? rawResult : [rawResult];
    const finalResult =
      [...resultsArray].reverse().find((r) => (r.fields?.length ?? 0) > 0) ??
      resultsArray[resultsArray.length - 1];

    if (!finalResult) {
      return {
        ok: true,
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs,
        command: "EMPTY",
        notice: "Query executed with no result set.",
      };
    }

    const allowEdit =
      !Array.isArray(rawResult) && isSimpleSingleTableSelect(trimmed);
    const metadata = await resolveFieldMetadata(
      pool,
      finalResult.fields ?? [],
      allowEdit
    );

    const totalReturned = finalResult.rows.length;
    const truncated = totalReturned > MAX_RESULT_ROWS;
    const boundedRows = truncated
      ? finalResult.rows.slice(0, MAX_RESULT_ROWS)
      : finalResult.rows;

    const rows = boundedRows.map((row) =>
      normalizeRow(row as Record<string, unknown>, finalResult.fields)
    );
    const command = (finalResult.command || "EMPTY") as SqlCommandTag;
    const rowCount =
      typeof finalResult.rowCount === "number"
        ? finalResult.rowCount
        : totalReturned;

    const notices: string[] = [];
    if (Array.isArray(rawResult) && rawResult.length > 1) {
      notices.push(
        `Executed ${rawResult.length} statements; displaying result set.`
      );
    }
    if (truncated) {
      notices.push(
        `Showing first ${MAX_RESULT_ROWS} of ${totalReturned} returned rows.`
      );
    }

    return {
      ok: true,
      columns: metadata.columns,
      rows,
      rowCount,
      durationMs,
      command,
      sourceTable: metadata.sourceTable,
      primaryKeyColumns: metadata.primaryKeyColumns,
      editable: metadata.editable,
      notice: notices.length > 0 ? notices.join(" ") : undefined,
    };
  } catch (error) {
    const durationMs = Math.max(
      0,
      Math.round((performance.now() - startedAt) * 100) / 100
    );
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs,
      command: "ERROR",
      error: formatPgError(error),
    };
  }
}

function parseQualifiedTableName(
  table: string
): { schema: string; name: string } | null {
  const trimmed = table.trim();
  if (!trimmed) {
    return null;
  }

  const unquote = (part: string) =>
    part.startsWith('"') && part.endsWith('"') && part.length >= 2
      ? part.slice(1, -1).replace(/""/g, '"')
      : part;

  const dotIndex = trimmed.indexOf(".");
  if (dotIndex === -1) {
    const name = unquote(trimmed);
    return name ? { schema: "public", name } : null;
  }

  const secondDot = trimmed.indexOf(".", dotIndex + 1);
  if (secondDot !== -1) {
    return null;
  }

  const schema = unquote(trimmed.slice(0, dotIndex).trim());
  const name = unquote(trimmed.slice(dotIndex + 1).trim());
  if (!schema || !name) {
    return null;
  }
  return { schema, name };
}

const TEXT_UDT_NAMES = new Set([
  "text",
  "varchar",
  "bpchar",
  "char",
  "name",
  "citext",
]);

function prepareCellParameter(
  value: PostgresValue,
  udtName: string,
  strictJsonValidation = false,
  isNullable = true
): PostgresValue | string {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value === "" && !TEXT_UDT_NAMES.has(udtName)) {
    if (isNullable) {
      return null;
    }
    throw new Error(`Column requires a non-empty value for type ${udtName}.`);
  }

  if (udtName === "json" || udtName === "jsonb") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      try {
        JSON.parse(value);
        return value;
      } catch (err) {
        if (
          strictJsonValidation &&
          (trimmed.startsWith("{") || trimmed.startsWith("["))
        ) {
          throw new Error(
            `Invalid JSON syntax: ${err instanceof Error ? err.message : "parse error"}`
          );
        }
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  if (udtName.startsWith("_") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array for PostgreSQL array column.`);
      }
      return parsed as PostgresValue;
    }
  }

  if (udtName === "bool" && typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "t" || lower === "1") {
      return true;
    }
    if (lower === "false" || lower === "f" || lower === "0") {
      return false;
    }
    throw new Error(`Invalid boolean value "${value}".`);
  }

  if (
    (udtName === "int2" || udtName === "int4" || udtName === "oid") &&
    typeof value === "string"
  ) {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }

  if ((udtName === "float4" || udtName === "float8") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return value;
}

export async function browseTableRows(input: {
  schema: string;
  table: string;
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  search?: string;
}): Promise<QueryExecutionResult> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "ERROR",
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const schemaName = typeof input.schema === "string" ? input.schema.trim() : "";
  const tableName = typeof input.table === "string" ? input.table.trim() : "";
  if (!schemaName || !tableName) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "ERROR",
      error: "Schema and table name are required.",
    };
  }

  const startedAt = performance.now();

  try {
    const pool = getPool();

    const tableMetaRes = await pool.query<{
      schema_name: string;
      table_name: string;
      table_oid: number;
      relkind: string;
    }>(
      `SELECT
         t.table_schema AS schema_name,
         t.table_name AS table_name,
         c.oid::int AS table_oid,
         c.relkind::text AS relkind
       FROM information_schema.tables t
       JOIN pg_namespace n ON n.nspname = t.table_schema
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
       WHERE t.table_schema = $1
         AND t.table_name = $2
         AND t.table_type IN ('BASE TABLE', 'VIEW')`,
      [schemaName, tableName]
    );

    const tableMeta = tableMetaRes.rows[0];
    if (!tableMeta) {
      return {
        ok: false,
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: Math.max(
          0,
          Math.round((performance.now() - startedAt) * 100) / 100
        ),
        command: "ERROR",
        error: `Table "${schemaName}.${tableName}" was not found.`,
      };
    }

    const [colsRes, pkRes] = await Promise.all([
      pool.query<{
        column_name: string;
        udt_name: string;
        oid: number;
        nullable: boolean;
      }>(
        `SELECT
           a.attname AS column_name,
           t.typname AS udt_name,
           a.atttypid::int AS oid,
           (NOT a.attnotnull) AS nullable
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
         WHERE a.attrelid = $1::oid
           AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY a.attnum ASC`,
        [tableMeta.table_oid]
      ),
      pool.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
         FROM pg_constraint con
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum AND NOT a.attisdropped
         WHERE con.conrelid = $1::oid AND con.contype = 'p'
         ORDER BY k.ord ASC`,
        [tableMeta.table_oid]
      ),
    ]);

    const columns: PostgresColumn[] = colsRes.rows.map((c) => {
      const oid = Number(c.oid) || 0;
      return {
        name: c.column_name,
        dataType: OID_TO_TYPE[oid] ?? formatUdtName(c.udt_name),
        oid,
        nullable: Boolean(c.nullable),
      };
    });

    const primaryKeyColumns = pkRes.rows.map((r) => r.column_name);
    const colSet = new Set(columns.map((c) => c.name));

    const rawPageSize =
      typeof input.pageSize === "number" && Number.isFinite(input.pageSize)
        ? Math.trunc(input.pageSize)
        : 50;
    const showAll = rawPageSize === 0;
    const pageSize = showAll ? 0 : Math.min(1000, Math.max(1, rawPageSize));
    const rawPage =
      typeof input.page === "number" && Number.isFinite(input.page)
        ? Math.trunc(input.page)
        : 1;
    const requestedPage = Math.max(1, rawPage);

    const searchTrimmed =
      typeof input.search === "string" ? input.search.trim() : "";
    const hasSearch = searchTrimmed.length > 0 && columns.length > 0;
    const baseParams: unknown[] = [];
    let whereClause = "";
    if (hasSearch) {
      const escapedSearch = searchTrimmed.replace(/[\\%_]/g, "\\$&");
      baseParams.push(`%${escapedSearch}%`);
      const predicates = columns.map(
        (c) => `CAST(${escapeIdentifier(c.name)} AS text) ILIKE $1`
      );
      whereClause = ` WHERE (${predicates.join(" OR ")})`;
    }

    let orderClause = "";
    let reverseRowsInMemory = false;
    const requestedSort =
      typeof input.sortColumn === "string" ? input.sortColumn.trim() : "";
    if (requestedSort === "__pgsa_hash__" && !colSet.has("__pgsa_hash__")) {
      const dir =
        input.sortDirection?.toLowerCase() === "desc" ? "DESC" : "ASC";
      if (primaryKeyColumns.length > 0) {
        orderClause = ` ORDER BY ${primaryKeyColumns
          .map((pk) => `${escapeIdentifier(pk)} ${dir}`)
          .join(", ")}`;
      } else if (tableMeta.relkind === "r" || tableMeta.relkind === "p") {
        orderClause = ` ORDER BY ctid ${dir}`;
      } else if (dir === "DESC") {
        reverseRowsInMemory = true;
      }
    } else if (requestedSort && colSet.has(requestedSort)) {
      const dir =
        input.sortDirection?.toLowerCase() === "desc" ? "DESC" : "ASC";
      const nulls = dir === "DESC" ? " NULLS LAST" : "";
      const tieBreakers = primaryKeyColumns
        .filter((pk) => pk !== requestedSort)
        .map((pk) => `${escapeIdentifier(pk)} ASC`);
      const orderParts = [
        `${escapeIdentifier(requestedSort)} ${dir}${nulls}`,
        ...tieBreakers,
      ];
      orderClause = ` ORDER BY ${orderParts.join(", ")}`;
    } else if (primaryKeyColumns.length > 0) {
      orderClause = ` ORDER BY ${primaryKeyColumns
        .map((pk) => `${escapeIdentifier(pk)} ASC`)
        .join(", ")}`;
    }

    const qualifiedTable = `${escapeIdentifier(tableMeta.schema_name)}.${escapeIdentifier(tableMeta.table_name)}`;

    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::bigint AS total FROM ${qualifiedTable}${whereClause}`,
      baseParams
    );

    const totalRows = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = showAll
      ? 1
      : Math.max(1, Math.ceil(totalRows / pageSize));
    const page = showAll ? 1 : Math.min(requestedPage, totalPages);
    const offset = showAll ? 0 : (page - 1) * pageSize;
    const effectiveLimit = showAll ? 50_000 : pageSize;

    const limitParamIdx = baseParams.length + 1;
    const offsetParamIdx = baseParams.length + 2;
    const dataRes = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${qualifiedTable}${whereClause}${orderClause} LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      [...baseParams, effectiveLimit, offset]
    );

    const durationMs = Math.max(
      0,
      Math.round((performance.now() - startedAt) * 100) / 100
    );

    const normalized = dataRes.rows.map((row) =>
      normalizeRow(row, dataRes.fields)
    );
    const rows = reverseRowsInMemory ? normalized.reverse() : normalized;
    const editable =
      (tableMeta.relkind === "r" || tableMeta.relkind === "p") &&
      primaryKeyColumns.length > 0;

    return {
      ok: true,
      columns,
      rows,
      rowCount: totalRows,
      totalRows,
      page,
      pageSize,
      durationMs,
      command: "SELECT",
      sourceTable: `${tableMeta.schema_name}.${tableMeta.table_name}`,
      primaryKeyColumns,
      editable,
    };
  } catch (error) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: Math.max(
        0,
        Math.round((performance.now() - startedAt) * 100) / 100
      ),
      command: "ERROR",
      error: formatPgError(error),
    };
  }
}

export async function updatePostgresCell(input: {
  table: string;
  primaryKey: Record<string, PostgresValue>;
  column: string;
  value: PostgresValue;
}): Promise<{ ok: boolean; error?: string; value?: PostgresValue }> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const parsedTable = parseQualifiedTableName(input.table);
  if (!parsedTable) {
    return {
      ok: false,
      error: "Invalid table identifier.",
    };
  }

  if (!input.column || typeof input.column !== "string") {
    return {
      ok: false,
      error: "Column name is required.",
    };
  }

  try {
    const pool = getPool();

    const tableRes = await pool.query<{ table_type: string }>(
      `SELECT table_type
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [parsedTable.schema, parsedTable.name]
    );

    const tableMeta = tableRes.rows[0];
    if (!tableMeta || tableMeta.table_type !== "BASE TABLE") {
      return {
        ok: false,
        error: `Table "${parsedTable.schema}.${parsedTable.name}" is not a writable base table.`,
      };
    }

    const colRes = await pool.query<{
      column_name: string;
      udt_name: string;
      is_nullable: string;
      is_generated: string;
    }>(
      `SELECT column_name, udt_name, is_nullable, is_generated
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [parsedTable.schema, parsedTable.name, input.column]
    );

    const targetCol = colRes.rows[0];
    if (!targetCol) {
      return {
        ok: false,
        error: `Column "${input.column}" does not exist on "${parsedTable.schema}.${parsedTable.name}".`,
      };
    }

    if (targetCol.is_generated === "ALWAYS") {
      return {
        ok: false,
        error: `Column "${targetCol.column_name}" is generated and cannot be edited directly.`,
      };
    }

    if (input.value === null && targetCol.is_nullable !== "YES") {
      return {
        ok: false,
        error: `Column "${targetCol.column_name}" is NOT NULL.`,
      };
    }

    const pkRes = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND NOT a.attisdropped
       WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
       ORDER BY k.ord ASC`,
      [parsedTable.schema, parsedTable.name]
    );

    const pkColumns = pkRes.rows.map((r) => r.column_name);
    if (pkColumns.length === 0) {
      return {
        ok: false,
        error: `Table "${parsedTable.schema}.${parsedTable.name}" has no primary key; inline updates require a primary key.`,
      };
    }

    const params: unknown[] = [
      prepareCellParameter(
        input.value,
        targetCol.udt_name,
        true,
        targetCol.is_nullable === "YES"
      ),
    ];

    const whereClauses: string[] = [];
    for (let idx = 0; idx < pkColumns.length; idx += 1) {
      const pkCol = pkColumns[idx];
      const pkVal = input.primaryKey?.[pkCol];
      if (pkVal === undefined || pkVal === null) {
        return {
          ok: false,
          error: `Missing primary key value for column "${pkCol}".`,
        };
      }
      params.push(pkVal);
      whereClauses.push(`${escapeIdentifier(pkCol)} = $${idx + 2}`);
    }

    const qualifiedTable = `${escapeIdentifier(parsedTable.schema)}.${escapeIdentifier(parsedTable.name)}`;
    const quotedCol = escapeIdentifier(targetCol.column_name);
    const updateSql = `UPDATE ${qualifiedTable} SET ${quotedCol} = $1 WHERE ${whereClauses.join(" AND ")} RETURNING ${quotedCol}`;

    const updateRes = await pool.query<Record<string, unknown>>(
      updateSql,
      params
    );

    if (updateRes.rowCount !== 1) {
      return {
        ok: false,
        error:
          updateRes.rowCount === 0
            ? "Target row was not found."
            : `Expected 1 updated row, but ${updateRes.rowCount} rows matched.`,
      };
    }

    const updatedValue = normalizePostgresValue(
      updateRes.rows[0]?.[targetCol.column_name],
      updateRes.fields[0]?.dataTypeID
    );

    return {
      ok: true,
      value: updatedValue,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatPgError(error),
    };
  }
}

export async function insertPostgresRow(input: {
  table: string;
  values: Record<string, PostgresValue | undefined>;
}): Promise<{ ok: boolean; row?: PostgresRow; error?: string }> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const parsedTable = parseQualifiedTableName(input.table);
  if (!parsedTable) {
    return {
      ok: false,
      error: "Invalid table identifier.",
    };
  }

  try {
    const pool = getPool();

    const tableRes = await pool.query<{ table_type: string }>(
      `SELECT table_type
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [parsedTable.schema, parsedTable.name]
    );

    const tableMeta = tableRes.rows[0];
    if (!tableMeta || tableMeta.table_type !== "BASE TABLE") {
      return {
        ok: false,
        error: `Table "${parsedTable.schema}.${parsedTable.name}" is not a writable base table.`,
      };
    }

    const colsRes = await pool.query<{
      column_name: string;
      udt_name: string;
      is_nullable: string;
      is_generated: string;
      is_identity: string;
      identity_generation: string | null;
      column_default: string | null;
    }>(
      `SELECT column_name, udt_name, is_nullable, is_generated, is_identity, identity_generation, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position ASC`,
      [parsedTable.schema, parsedTable.name]
    );

    const colMap = new Map(colsRes.rows.map((c) => [c.column_name, c]));

    const insertCols: string[] = [];
    const params: unknown[] = [];

    for (const [colName, rawVal] of Object.entries(input.values ?? {})) {
      if (rawVal === undefined) {
        continue;
      }

      const col = colMap.get(colName);
      if (!col) {
        return {
          ok: false,
          error: `Column "${colName}" does not exist on "${parsedTable.schema}.${parsedTable.name}".`,
        };
      }

      if (col.is_generated === "ALWAYS") {
        return {
          ok: false,
          error: `Column "${colName}" is generated and cannot be specified on insert.`,
        };
      }

      if (col.is_identity === "YES" && col.identity_generation === "ALWAYS") {
        return {
          ok: false,
          error: `Identity column "${colName}" (GENERATED ALWAYS) cannot be overridden.`,
        };
      }

      if (rawVal === null && col.is_nullable !== "YES") {
        return {
          ok: false,
          error: `Column "${colName}" is NOT NULL.`,
        };
      }

      insertCols.push(escapeIdentifier(col.column_name));
      params.push(
        prepareCellParameter(
          rawVal,
          col.udt_name,
          true,
          col.is_nullable === "YES"
        )
      );
    }

    const qualifiedTable = `${escapeIdentifier(parsedTable.schema)}.${escapeIdentifier(parsedTable.name)}`;
    const insertSql =
      insertCols.length === 0
        ? `INSERT INTO ${qualifiedTable} DEFAULT VALUES RETURNING *`
        : `INSERT INTO ${qualifiedTable} (${insertCols.join(", ")}) VALUES (${insertCols
            .map((_, idx) => `$${idx + 1}`)
            .join(", ")}) RETURNING *`;

    const res = await pool.query<Record<string, unknown>>(insertSql, params);
    const inserted = res.rows[0];
    if (!inserted) {
      return {
        ok: false,
        error: "Insert succeeded without returning a row.",
      };
    }

    return {
      ok: true,
      row: normalizeRow(inserted, res.fields),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatPgError(error),
    };
  }
}

export async function deletePostgresRows(input: {
  table: string;
  primaryKeys: Array<Record<string, PostgresValue>>;
}): Promise<{ ok: boolean; deletedCount: number; error?: string }> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      deletedCount: 0,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const parsedTable = parseQualifiedTableName(input.table);
  if (!parsedTable) {
    return {
      ok: false,
      deletedCount: 0,
      error: "Invalid table identifier.",
    };
  }

  if (!Array.isArray(input.primaryKeys) || input.primaryKeys.length === 0) {
    return {
      ok: false,
      deletedCount: 0,
      error: "At least one row primary key is required.",
    };
  }

  if (input.primaryKeys.length > MAX_DELETE_BATCH) {
    return {
      ok: false,
      deletedCount: 0,
      error: `Delete batch exceeds maximum of ${MAX_DELETE_BATCH} rows.`,
    };
  }

  const pool = getPool();

  let pkColumns: string[];
  try {
    const tableRes = await pool.query<{ table_type: string }>(
      `SELECT table_type
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [parsedTable.schema, parsedTable.name]
    );

    const tableMeta = tableRes.rows[0];
    if (!tableMeta || tableMeta.table_type !== "BASE TABLE") {
      return {
        ok: false,
        deletedCount: 0,
        error: `Table "${parsedTable.schema}.${parsedTable.name}" is not a writable base table.`,
      };
    }

    const pkRes = await pool.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum AND NOT a.attisdropped
       WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
       ORDER BY k.ord ASC`,
      [parsedTable.schema, parsedTable.name]
    );

    pkColumns = pkRes.rows.map((r) => r.column_name);
    if (pkColumns.length === 0) {
      return {
        ok: false,
        deletedCount: 0,
        error: `Table "${parsedTable.schema}.${parsedTable.name}" has no primary key; row deletion requires a primary key.`,
      };
    }

    for (const pkTuple of input.primaryKeys) {
      for (const pkCol of pkColumns) {
        const val = pkTuple?.[pkCol];
        if (val === undefined || val === null) {
          return {
            ok: false,
            deletedCount: 0,
            error: `Missing primary key value for column "${pkCol}".`,
          };
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      deletedCount: 0,
      error: formatPgError(error),
    };
  }

  const qualifiedTable = `${escapeIdentifier(parsedTable.schema)}.${escapeIdentifier(parsedTable.name)}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    let deletedCount = 0;

    for (const pkTuple of input.primaryKeys) {
      const params: unknown[] = [];
      const whereClauses = pkColumns.map((pkCol, idx) => {
        params.push(pkTuple[pkCol]);
        return `${escapeIdentifier(pkCol)} = $${idx + 1}`;
      });
      const delSql = `DELETE FROM ${qualifiedTable} WHERE ${whereClauses.join(" AND ")}`;
      const res = await client.query(delSql, params);
      deletedCount += res.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { ok: true, deletedCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return {
      ok: false,
      deletedCount: 0,
      error: formatPgError(error),
    };
  } finally {
    client.release();
  }
}

interface BackupTableMeta {
  oid: number;
  schema: string;
  name: string;
  fqn: string;
}

interface BackupColumnMeta {
  attnum: number;
  name: string;
  formattedType: string;
  udtName: string;
  typeOid: number;
  notNull: boolean;
  defaultExpr: string | null;
  identity: string;
  generated: string;
}

interface BackupConstraintMeta {
  conname: string;
  contype: "p" | "u" | "f";
  definition: string;
  targetFqn: string | null;
}

function toSqlLiteral(value: unknown, udtName: string): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : escapeLiteral(String(value));
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? escapeLiteral(String(value))
      : escapeLiteral(value.toISOString());
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `${escapeLiteral(`\\x${Buffer.from(value).toString("hex")}`)}::bytea`;
  }

  if (udtName === "json" || udtName === "jsonb") {
    const jsonText =
      typeof value === "string" ? value : JSON.stringify(value);
    return `${escapeLiteral(jsonText)}::${udtName}`;
  }

  if (udtName.startsWith("_") && Array.isArray(value)) {
    const elemUdt = udtName.slice(1);
    if (value.length === 0) {
      return `'{}'::${elemUdt}[]`;
    }
    const items = value.map((item) => toSqlLiteral(item, elemUdt));
    return `ARRAY[${items.join(", ")}]::${elemUdt}[]`;
  }

  if (typeof value === "object") {
    const withToPostgres = value as { toPostgres?: () => string };
    if (typeof withToPostgres.toPostgres === "function") {
      return escapeLiteral(withToPostgres.toPostgres());
    }
    return escapeLiteral(JSON.stringify(value));
  }

  return escapeLiteral(String(value));
}

function makeCreateIndexIfNotExists(indexDef: string): string {
  return indexDef
    .replace(/^CREATE UNIQUE INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
}

function sortTablesTopologically(
  tables: BackupTableMeta[],
  depsByFqn: Map<string, Set<string>>
): BackupTableMeta[] {
  const byFqn = new Map(tables.map((t) => [t.fqn, t]));
  const remaining = new Map<string, Set<string>>();
  for (const t of tables) {
    const filtered = new Set<string>();
    for (const dep of depsByFqn.get(t.fqn) ?? []) {
      if (dep !== t.fqn && byFqn.has(dep)) {
        filtered.add(dep);
      }
    }
    remaining.set(t.fqn, filtered);
  }

  const ordered: BackupTableMeta[] = [];
  const placed = new Set<string>();

  while (ordered.length < tables.length) {
    const ready = tables
      .filter(
        (t) =>
          !placed.has(t.fqn) && (remaining.get(t.fqn)?.size ?? 0) === 0
      )
      .sort((a, b) => a.fqn.localeCompare(b.fqn));

    const next =
      ready[0] ??
      tables
        .filter((t) => !placed.has(t.fqn))
        .sort((a, b) => a.fqn.localeCompare(b.fqn))[0];

    if (!next) {
      break;
    }

    ordered.push(next);
    placed.add(next.fqn);
    for (const deps of remaining.values()) {
      deps.delete(next.fqn);
    }
  }

  return ordered;
}

export async function generatePostgresBackup(
  options: BackupOptions
): Promise<BackupResult> {
  const emptyBackup = (error: string): BackupResult => ({
    ok: false,
    filename: "",
    content: "",
    statementCount: 0,
    rowCount: 0,
    sizeBytes: 0,
    error,
  });

  const status = getEnvStatus();
  if (!status.configured) {
    return emptyBackup(
      `Missing required environment variable(s): ${status.missing.join(", ")}.`
    );
  }

  const format = options.format === "json" ? "json" : "sql";
  const includeSchema = Boolean(options.includeSchema);
  const includeData = Boolean(options.includeData);

  if (!includeSchema && !includeData) {
    return emptyBackup("Select at least schema or data to generate a backup.");
  }

  try {
    const pool = getPool();

    const [metaRes, allTablesRes] = await Promise.all([
      pool.query<{ database_name: string; server_version: string }>(
        "SELECT current_database() AS database_name, version() AS server_version"
      ),
      pool.query<{ oid: number; schema_name: string; table_name: string }>(`
        SELECT c.oid::int AS oid, n.nspname AS schema_name, c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
          AND NOT c.relispartition
          AND c.relkind IN ('r', 'p')
        ORDER BY
          CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END,
          n.nspname ASC,
          c.relname ASC
      `),
    ]);

    const dbName = metaRes.rows[0]?.database_name ?? "";
    const serverVersion = metaRes.rows[0]?.server_version ?? "";

    const allTables: BackupTableMeta[] = allTablesRes.rows.map((r) => ({
      oid: r.oid,
      schema: r.schema_name,
      name: r.table_name,
      fqn: `${r.schema_name}.${r.table_name}`,
    }));

    const byFqn = new Map(allTables.map((t) => [t.fqn, t]));
    let selectedTables: BackupTableMeta[];

    if (options.tables.length > 0) {
      selectedTables = [];
      const seen = new Set<string>();
      for (const rawName of options.tables) {
        const parsed = parseQualifiedTableName(rawName);
        if (!parsed) {
          return emptyBackup(`Invalid table identifier "${rawName}".`);
        }
        const fqn = `${parsed.schema}.${parsed.name}`;
        const match = byFqn.get(fqn);
        if (!match) {
          return emptyBackup(`Table "${fqn}" does not exist.`);
        }
        if (!seen.has(fqn)) {
          seen.add(fqn);
          selectedTables.push(match);
        }
      }
    } else {
      selectedTables = allTables;
    }

    const selectedOids = selectedTables.map((t) => t.oid);

    const colsByTable = new Map<string, BackupColumnMeta[]>();
    const pkByTable = new Map<string, string[]>();
    const constraintsByTable = new Map<string, BackupConstraintMeta[]>();
    const depsByFqn = new Map<string, Set<string>>();
    const indexesByTable = new Map<string, string[]>();
    const sequencesToCreate: Array<{
      schema: string;
      name: string;
      isIdentity: boolean;
      ownedBy: string | null;
    }> = [];

    if (selectedOids.length > 0) {
      const [colsRes, pkRes, conRes, idxRes, seqRes] = await Promise.all([
        pool.query<{
          table_oid: number;
          attnum: number;
          column_name: string;
          formatted_type: string;
          udt_name: string;
          type_oid: number;
          not_null: boolean;
          default_expr: string | null;
          identity: string;
          generated: string;
        }>(
          `SELECT
             a.attrelid::int AS table_oid,
             a.attnum::int AS attnum,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS formatted_type,
             t.typname AS udt_name,
             a.atttypid::int AS type_oid,
             a.attnotnull AS not_null,
             pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
             a.attidentity::text AS identity,
             a.attgenerated::text AS generated
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
           WHERE a.attrelid = ANY($1::oid[])
             AND a.attnum > 0
             AND NOT a.attisdropped
           ORDER BY a.attrelid, a.attnum ASC`,
          [selectedOids]
        ),
        pool.query<{
          table_oid: number;
          column_name: string;
        }>(
          `SELECT con.conrelid::int AS table_oid, a.attname AS column_name
           FROM pg_constraint con
           CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum AND NOT a.attisdropped
           WHERE con.conrelid = ANY($1::oid[]) AND con.contype = 'p'
           ORDER BY con.conrelid, k.ord ASC`,
          [selectedOids]
        ),
        pool.query<{
          table_oid: number;
          conname: string;
          contype: string;
          definition: string;
          target_schema: string | null;
          target_table: string | null;
        }>(
          `SELECT
             con.conrelid::int AS table_oid,
             con.conname AS conname,
             con.contype::text AS contype,
             pg_get_constraintdef(con.oid, true) AS definition,
             tn.nspname AS target_schema,
             tc.relname AS target_table
           FROM pg_constraint con
           LEFT JOIN pg_class tc ON tc.oid = con.confrelid
           LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
           WHERE con.conrelid = ANY($1::oid[])
             AND con.contype IN ('p', 'u', 'f')
           ORDER BY
             con.conrelid,
             CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 ELSE 2 END,
             con.conname ASC`,
          [selectedOids]
        ),
        pool.query<{
          table_oid: number;
          indexdef: string;
        }>(
          `SELECT
             i.indrelid::int AS table_oid,
             pg_get_indexdef(i.indexrelid) AS indexdef
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
           WHERE i.indrelid = ANY($1::oid[])
             AND NOT i.indisprimary
             AND con.oid IS NULL
           ORDER BY i.indrelid, ic.relname ASC`,
          [selectedOids]
        ),
        pool.query<{
          seq_schema: string;
          seq_name: string;
          is_identity: boolean;
          table_schema: string | null;
          table_name: string | null;
          col_name: string | null;
        }>(
          `SELECT DISTINCT
             sn.nspname AS seq_schema,
             sc.relname AS seq_name,
             (COALESCE(ta.attidentity, '') IN ('a', 'd') AND d.deptype = 'i') AS is_identity,
             tn.nspname AS table_schema,
             tc.relname AS table_name,
             ta.attname AS col_name
           FROM pg_class sc
           JOIN pg_namespace sn ON sn.oid = sc.relnamespace
           LEFT JOIN pg_depend d ON d.objid = sc.oid AND d.deptype IN ('a', 'i')
           LEFT JOIN pg_class tc ON tc.oid = d.refobjid
           LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
           LEFT JOIN pg_attribute ta ON ta.attrelid = d.refobjid AND ta.attnum = d.refobjsubid
           WHERE sc.relkind = 'S'
             AND (
               d.refobjid = ANY($1::oid[])
               OR sn.nspname NOT IN ('pg_catalog', 'information_schema')
             )
             AND sn.nspname NOT LIKE 'pg_toast%'
             AND sn.nspname NOT LIKE 'pg_temp_%'
           ORDER BY sn.nspname, sc.relname ASC`,
          [selectedOids]
        ),
      ]);

      const oidToFqn = new Map(selectedTables.map((t) => [t.oid, t.fqn]));

      for (const row of colsRes.rows) {
        const fqn = oidToFqn.get(row.table_oid);
        if (!fqn) continue;
        const list = colsByTable.get(fqn) ?? [];
        list.push({
          attnum: row.attnum,
          name: row.column_name,
          formattedType: row.formatted_type,
          udtName: row.udt_name,
          typeOid: row.type_oid,
          notNull: row.not_null,
          defaultExpr: row.default_expr,
          identity: row.identity,
          generated: row.generated,
        });
        colsByTable.set(fqn, list);
      }

      for (const row of pkRes.rows) {
        const fqn = oidToFqn.get(row.table_oid);
        if (!fqn) continue;
        const list = pkByTable.get(fqn) ?? [];
        list.push(row.column_name);
        pkByTable.set(fqn, list);
      }

      for (const row of conRes.rows) {
        const fqn = oidToFqn.get(row.table_oid);
        if (!fqn) continue;
        const targetFqn =
          row.target_schema && row.target_table
            ? `${row.target_schema}.${row.target_table}`
            : null;

        if (row.contype === "f" && targetFqn) {
          const deps = depsByFqn.get(fqn) ?? new Set<string>();
          deps.add(targetFqn);
          depsByFqn.set(fqn, deps);
        }

        const list = constraintsByTable.get(fqn) ?? [];
        list.push({
          conname: row.conname,
          contype: row.contype as "p" | "u" | "f",
          definition: row.definition,
          targetFqn,
        });
        constraintsByTable.set(fqn, list);
      }

      for (const row of idxRes.rows) {
        const fqn = oidToFqn.get(row.table_oid);
        if (!fqn) continue;
        const list = indexesByTable.get(fqn) ?? [];
        list.push(row.indexdef);
        indexesByTable.set(fqn, list);
      }

      for (const row of seqRes.rows) {
        if (
          row.table_schema &&
          row.table_name &&
          byFqn.has(`${row.table_schema}.${row.table_name}`)
        ) {
          const tableFqn = `${row.table_schema}.${row.table_name}`;
          if (!selectedTables.some((t) => t.fqn === tableFqn)) {
            continue;
          }
        }
        sequencesToCreate.push({
          schema: row.seq_schema,
          name: row.seq_name,
          isIdentity: Boolean(row.is_identity),
          ownedBy:
            row.table_schema && row.table_name && row.col_name
              ? `${escapeIdentifier(row.table_schema)}.${escapeIdentifier(row.table_name)}.${escapeIdentifier(row.col_name)}`
              : null,
        });
      }
    }

    const orderedTables = sortTablesTopologically(selectedTables, depsByFqn);
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const safeDbSlug = dbName.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = safeDbSlug
      ? `pgsa-backup-${safeDbSlug}-${stamp}.${format}`
      : `pgsa-backup-${stamp}.${format}`;

    if (format === "json") {
      const jsonTables: Record<
        string,
        {
          columns: PostgresColumn[];
          primaryKeyColumns: string[];
          rows: PostgresRow[];
        }
      > = {};
      let totalRows = 0;
      let cumulativeBytes = 256;

      for (const tbl of orderedTables) {
        const cols = colsByTable.get(tbl.fqn) ?? [];
        const pkCols = pkByTable.get(tbl.fqn) ?? [];
        let rows: PostgresRow[] = [];

        if (includeData) {
          const remainingRows = MAX_BACKUP_ROWS - totalRows;
          if (remainingRows <= 0) {
            return emptyBackup(
              `Backup aborted: total exported rows exceed limit of ${MAX_BACKUP_ROWS.toLocaleString()}.`
            );
          }
          const orderClause =
            pkCols.length > 0
              ? ` ORDER BY ${pkCols.map((c) => escapeIdentifier(c)).join(", ")}`
              : "";
          const dataRes = await pool.query<Record<string, unknown>>(
            `SELECT * FROM ${escapeIdentifier(tbl.schema)}.${escapeIdentifier(tbl.name)}${orderClause} LIMIT $1`,
            [remainingRows + 1]
          );
          if (dataRes.rows.length > remainingRows) {
            return emptyBackup(
              `Backup aborted: total exported rows exceed limit of ${MAX_BACKUP_ROWS.toLocaleString()}.`
            );
          }
          rows = dataRes.rows.map((r) => normalizeRow(r, dataRes.fields));
          totalRows += rows.length;
        }

        const tableEntry = {
          columns: includeSchema
            ? cols.map((c) => ({
                name: c.name,
                dataType: OID_TO_TYPE[c.typeOid] ?? formatUdtName(c.udtName),
                oid: c.typeOid,
                nullable: !c.notNull,
              }))
            : [],
          primaryKeyColumns: includeSchema ? pkCols : [],
          rows,
        };

        cumulativeBytes +=
          Buffer.byteLength(JSON.stringify(tbl.fqn), "utf8") +
          Buffer.byteLength(JSON.stringify(tableEntry, null, 2), "utf8") +
          16;
        if (cumulativeBytes > MAX_BACKUP_BYTES) {
          return emptyBackup(
            `Backup aborted: JSON export exceeds maximum size of ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB.`
          );
        }

        jsonTables[tbl.fqn] = tableEntry;
      }

      const content = JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          database: dbName,
          serverVersion,
          includeSchema,
          includeData,
          tables: jsonTables,
        },
        null,
        2
      );

      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > MAX_BACKUP_BYTES) {
        return emptyBackup(
          `Backup aborted: JSON export exceeds maximum size of ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB.`
        );
      }

      return {
        ok: true,
        filename,
        content,
        statementCount: orderedTables.length,
        rowCount: totalRows,
        sizeBytes,
      };
    }

    // SQL dump generation
    const lines: string[] = [
      "-- PGSA Logical Backup",
      `-- Database: ${dbName}`,
      `-- Server: ${serverVersion}`,
      `-- Generated at: ${new Date().toISOString()}`,
      `-- Options: schema=${includeSchema}, data=${includeData}`,
      "",
    ];

    let cumulativeBytes = Buffer.byteLength(lines.join("\n"), "utf8");
    const pushSqlLine = (line: string) => {
      cumulativeBytes += Buffer.byteLength(line, "utf8") + 1;
      if (cumulativeBytes > MAX_BACKUP_BYTES) {
        throw new BackupLimitError(
          `Backup aborted: SQL export exceeds maximum size of ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB.`
        );
      }
      lines.push(line);
    };

    let statementCount = 0;
    let totalRows = 0;

    if (includeSchema) {
      const customSchemas = Array.from(
        new Set(orderedTables.map((t) => t.schema).filter((s) => s !== "public"))
      );

      for (const schemaName of customSchemas) {
        pushSqlLine(`CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(schemaName)};`);
        statementCount += 1;
      }
      if (customSchemas.length > 0) {
        pushSqlLine("");
      }

      const standaloneSequences = sequencesToCreate.filter((s) => !s.isIdentity);
      if (standaloneSequences.length > 0) {
        for (const seq of standaloneSequences) {
          pushSqlLine(
            `CREATE SEQUENCE IF NOT EXISTS ${escapeIdentifier(seq.schema)}.${escapeIdentifier(seq.name)};`
          );
          statementCount += 1;
        }
        pushSqlLine("");
      }

      const createdTables = new Set<string>();
      const deferredFks: Array<{
        fqn: string;
        conname: string;
        definition: string;
      }> = [];

      for (const tbl of orderedTables) {
        const cols = colsByTable.get(tbl.fqn) ?? [];
        const cons = constraintsByTable.get(tbl.fqn) ?? [];

        const itemDefs: string[] = [];
        for (const col of cols) {
          const colParts = [
            `  ${escapeIdentifier(col.name)} ${col.formattedType}`,
          ];
          if (col.notNull) {
            colParts.push("NOT NULL");
          }
          if (col.generated === "s" && col.defaultExpr) {
            colParts.push(`GENERATED ALWAYS AS (${col.defaultExpr}) STORED`);
          } else if (col.identity === "a") {
            colParts.push("GENERATED ALWAYS AS IDENTITY");
          } else if (col.identity === "d") {
            colParts.push("GENERATED BY DEFAULT AS IDENTITY");
          } else if (col.defaultExpr !== null) {
            colParts.push(`DEFAULT ${col.defaultExpr}`);
          }
          itemDefs.push(colParts.join(" "));
        }

        for (const con of cons) {
          if (con.contype === "p" || con.contype === "u") {
            itemDefs.push(
              `  CONSTRAINT ${escapeIdentifier(con.conname)} ${con.definition}`
            );
          } else if (con.contype === "f") {
            if (
              con.targetFqn &&
              con.targetFqn !== tbl.fqn &&
              createdTables.has(con.targetFqn)
            ) {
              itemDefs.push(
                `  CONSTRAINT ${escapeIdentifier(con.conname)} ${con.definition}`
              );
            } else {
              deferredFks.push({
                fqn: `${escapeIdentifier(tbl.schema)}.${escapeIdentifier(tbl.name)}`,
                conname: con.conname,
                definition: con.definition,
              });
            }
          }
        }

        pushSqlLine(
          `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(tbl.schema)}.${escapeIdentifier(tbl.name)} (`
        );
        pushSqlLine(itemDefs.join(",\n"));
        pushSqlLine(");");
        pushSqlLine("");
        statementCount += 1;
        createdTables.add(tbl.fqn);
      }

      if (deferredFks.length > 0) {
        for (const fk of deferredFks) {
          pushSqlLine(
            `ALTER TABLE ${fk.fqn} ADD CONSTRAINT ${escapeIdentifier(fk.conname)} ${fk.definition};`
          );
          statementCount += 1;
        }
        pushSqlLine("");
      }

      for (const tbl of orderedTables) {
        const idxDefs = indexesByTable.get(tbl.fqn) ?? [];
        for (const def of idxDefs) {
          pushSqlLine(`${makeCreateIndexIfNotExists(def)};`);
          statementCount += 1;
        }
        if (idxDefs.length > 0) {
          pushSqlLine("");
        }
      }
    }

    if (includeData) {
      for (const tbl of orderedTables) {
        const cols = (colsByTable.get(tbl.fqn) ?? []).filter(
          (c) => c.generated !== "s"
        );
        if (cols.length === 0) {
          continue;
        }

        const remainingRows = MAX_BACKUP_ROWS - totalRows;
        if (remainingRows <= 0) {
          return emptyBackup(
            `Backup aborted: total exported rows exceed limit of ${MAX_BACKUP_ROWS.toLocaleString()}.`
          );
        }

        const pkCols = pkByTable.get(tbl.fqn) ?? [];
        const orderClause =
          pkCols.length > 0
            ? ` ORDER BY ${pkCols.map((c) => escapeIdentifier(c)).join(", ")}`
            : "";

        const qualifiedTable = `${escapeIdentifier(tbl.schema)}.${escapeIdentifier(tbl.name)}`;
        const selectColList = cols.map((c) => escapeIdentifier(c.name)).join(", ");
        const dataRes = await pool.query<Record<string, unknown>>(
          `SELECT ${selectColList} FROM ${qualifiedTable}${orderClause} LIMIT $1`,
          [remainingRows + 1]
        );

        if (dataRes.rows.length > remainingRows) {
          return emptyBackup(
            `Backup aborted: total exported rows exceed limit of ${MAX_BACKUP_ROWS.toLocaleString()}.`
          );
        }

        if (dataRes.rows.length === 0) {
          continue;
        }

        const hasAlwaysIdentity = cols.some((c) => c.identity === "a");
        const overrideClause = hasAlwaysIdentity
          ? " OVERRIDING SYSTEM VALUE"
          : "";

        pushSqlLine(`-- Data for ${tbl.fqn} (${dataRes.rows.length} rows)`);

        for (let i = 0; i < dataRes.rows.length; i += INSERT_BATCH_SIZE) {
          const chunk = dataRes.rows.slice(i, i + INSERT_BATCH_SIZE);
          const valueRows = chunk.map((row) => {
            const literals = cols.map((c) =>
              toSqlLiteral(row[c.name], c.udtName)
            );
            return `  (${literals.join(", ")})`;
          });

          pushSqlLine(
            `INSERT INTO ${qualifiedTable} (${selectColList})${overrideClause} VALUES\n${valueRows.join(",\n")};`
          );
          statementCount += 1;
        }

        totalRows += dataRes.rows.length;
        pushSqlLine("");
      }

      if (includeSchema && sequencesToCreate.length > 0) {
        for (const seq of sequencesToCreate) {
          const seqFqn = `${escapeIdentifier(seq.schema)}.${escapeIdentifier(seq.name)}`;
          try {
            const valRes = await pool.query<{
              last_value: string;
              is_called: boolean;
            }>(`SELECT last_value::text, is_called FROM ${seqFqn}`);
            const seqState = valRes.rows[0];
            if (seqState) {
              pushSqlLine(
                `SELECT pg_catalog.setval(${escapeLiteral(`${seq.schema}.${seq.name}`)}, ${seqState.last_value}, ${seqState.is_called ? "true" : "false"});`
              );
              statementCount += 1;
            }
          } catch (seqErr) {
            if (seqErr instanceof BackupLimitError) {
              throw seqErr;
            }
            // Skip sequence value sync if unreadable
          }
        }
        pushSqlLine("");
      }
    }

    const content = lines.join("\n");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > MAX_BACKUP_BYTES) {
      return emptyBackup(
        `Backup aborted: SQL export exceeds maximum size of ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB.`
      );
    }

    return {
      ok: true,
      filename,
      content,
      statementCount,
      rowCount: totalRows,
      sizeBytes,
    };
  } catch (error) {
    if (error instanceof BackupLimitError) {
      return emptyBackup(error.message);
    }
    return emptyBackup(formatPgError(error));
  }
}

export async function restorePostgresSql(input: {
  sql: string;
  singleTransaction: boolean;
}): Promise<RestoreResult> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      statementsExecuted: 0,
      durationMs: 0,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  if (typeof input.sql !== "string" || input.sql.trim().length === 0) {
    return {
      ok: false,
      statementsExecuted: 0,
      durationMs: 0,
      error: "SQL restore input is empty.",
    };
  }

  const statements = splitTopLevelSqlStatements(input.sql);
  if (statements.length === 0) {
    return {
      ok: false,
      statementsExecuted: 0,
      durationMs: 0,
      error: "No executable SQL statements found in restore input.",
    };
  }

  const pool = getPool();
  const client = await pool.connect();
  const startedAt = performance.now();
  let statementsExecuted = 0;
  let currentStatement = "";

  try {
    if (input.singleTransaction) {
      await client.query("BEGIN");
    }

    for (const stmt of statements) {
      currentStatement = stmt;
      await client.query(stmt);
      statementsExecuted += 1;
    }

    if (input.singleTransaction) {
      await client.query("COMMIT");
    }

    return {
      ok: true,
      statementsExecuted,
      durationMs: Math.max(
        0,
        Math.round((performance.now() - startedAt) * 100) / 100
      ),
    };
  } catch (error) {
    if (input.singleTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    return {
      ok: false,
      statementsExecuted,
      durationMs: Math.max(
        0,
        Math.round((performance.now() - startedAt) * 100) / 100
      ),
      error: formatPgError(error),
      failedStatement: currentStatement.slice(0, 500),
    };
  } finally {
    client.release();
  }
}

function toIsoStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return String(value);
}

export async function fetchActivityAndStats(): Promise<ActivityAndStatsPayload> {
  const emptyPayload = (error: string): ActivityAndStatsPayload => ({
    ok: false,
    currentPid: 0,
    databaseName: "",
    databaseSizeBytes: 0,
    activities: [],
    tableStats: [],
    roles: [],
    extensions: [],
    error,
  });

  const status = getEnvStatus();
  if (!status.configured) {
    return emptyPayload(
      `Missing required environment variable(s): ${status.missing.join(", ")}.`
    );
  }

  try {
    const pool = getPool();
    const [dbRes, activityRes, tableStatsRes, rolesRes, extRes] =
      await Promise.all([
        pool.query<{
          current_pid: number;
          database_name: string;
          database_size_bytes: string;
        }>(`
          SELECT
            pg_backend_pid()::int AS current_pid,
            current_database() AS database_name,
            pg_database_size(current_database())::bigint AS database_size_bytes
        `),
        pool.query<{
          pid: number;
          usename: string | null;
          datname: string | null;
          application_name: string;
          client_addr: string | null;
          state: string | null;
          wait_event_type: string | null;
          wait_event: string | null;
          query: string;
          duration_ms: number | null;
          backend_start: Date | string | null;
          query_start: Date | string | null;
          is_current_backend: boolean;
        }>(`
          SELECT
            pid::int AS pid,
            usename,
            datname,
            COALESCE(application_name, '') AS application_name,
            host(client_addr) AS client_addr,
            state,
            wait_event_type,
            wait_event,
            COALESCE(query, '') AS query,
            CASE
              WHEN query_start IS NOT NULL AND state = 'active'
                THEN GREATEST(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::double precision
              ELSE NULL
            END AS duration_ms,
            backend_start,
            query_start,
            (pid = pg_backend_pid()) AS is_current_backend
          FROM pg_stat_activity
          WHERE datname = current_database() OR datname IS NULL
          ORDER BY (state = 'active') DESC, query_start DESC NULLS LAST, pid ASC
          LIMIT 200
        `),
        pool.query<{
          schema_name: string;
          table_name: string;
          row_estimate: string;
          total_bytes: string;
          table_bytes: string;
          index_bytes: string;
          seq_scan: string;
          idx_scan: string;
          n_dead_tup: string;
        }>(`
          SELECT
            s.schemaname AS schema_name,
            s.relname AS table_name,
            GREATEST(
              COALESCE(c.reltuples, 0)::bigint,
              COALESCE(s.n_live_tup, 0),
              0
            )::bigint AS row_estimate,
            COALESCE(pg_total_relation_size(s.relid), 0)::bigint AS total_bytes,
            COALESCE(pg_table_size(s.relid), 0)::bigint AS table_bytes,
            COALESCE(pg_indexes_size(s.relid), 0)::bigint AS index_bytes,
            COALESCE(s.seq_scan, 0)::bigint AS seq_scan,
            COALESCE(s.idx_scan, 0)::bigint AS idx_scan,
            COALESCE(s.n_dead_tup, 0)::bigint AS n_dead_tup
          FROM pg_stat_user_tables s
          JOIN pg_class c ON c.oid = s.relid
          ORDER BY pg_total_relation_size(s.relid) DESC, s.schemaname, s.relname
        `),
        pool.query<{
          rolname: string;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolcanlogin: boolean;
          rolconnlimit: number;
        }>(`
          SELECT
            rolname,
            rolsuper,
            rolcreatedb,
            rolcreaterole,
            rolcanlogin,
            rolconnlimit::int AS rolconnlimit
          FROM pg_roles
          ORDER BY (rolname LIKE 'pg\\_%' ESCAPE '\\') ASC, rolsuper DESC, rolcanlogin DESC, rolname ASC
        `),
        pool.query<{
          name: string;
          version: string;
          schema: string;
        }>(`
          SELECT
            e.extname AS name,
            e.extversion AS version,
            n.nspname AS schema
          FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
          ORDER BY e.extname ASC
        `),
      ]);

    const dbMeta = dbRes.rows[0];
    const activities: ActivityProcess[] = activityRes.rows.map((r) => ({
      pid: r.pid,
      usename: r.usename,
      datname: r.datname,
      applicationName: r.application_name,
      clientAddr: r.client_addr,
      state: r.state,
      waitEventType: r.wait_event_type,
      waitEvent: r.wait_event,
      query: r.query,
      durationMs:
        r.duration_ms !== null
          ? Math.round(Number(r.duration_ms) * 100) / 100
          : null,
      backendStart: toIsoStringOrNull(r.backend_start),
      queryStart: toIsoStringOrNull(r.query_start),
      isCurrentBackend: Boolean(r.is_current_backend),
    }));

    const tableStats: TableStorageStat[] = tableStatsRes.rows.map((r) => ({
      schema: r.schema_name,
      name: r.table_name,
      rowEstimate: Number(r.row_estimate) || 0,
      totalBytes: Number(r.total_bytes) || 0,
      tableBytes: Number(r.table_bytes) || 0,
      indexBytes: Number(r.index_bytes) || 0,
      seqScan: Number(r.seq_scan) || 0,
      idxScan: Number(r.idx_scan) || 0,
      nDeadTup: Number(r.n_dead_tup) || 0,
    }));

    const roles: PgRoleInfo[] = rolesRes.rows.map((r) => ({
      rolname: r.rolname,
      rolsuper: Boolean(r.rolsuper),
      rolcreatedb: Boolean(r.rolcreatedb),
      rolcreaterole: Boolean(r.rolcreaterole),
      rolcanlogin: Boolean(r.rolcanlogin),
      rolconnlimit: Number(r.rolconnlimit),
    }));

    const extensions: PgExtensionInfo[] = extRes.rows.map((r) => ({
      name: r.name,
      version: r.version,
      schema: r.schema,
    }));

    return {
      ok: true,
      currentPid: dbMeta?.current_pid ?? 0,
      databaseName: dbMeta?.database_name ?? "",
      databaseSizeBytes: Number(dbMeta?.database_size_bytes) || 0,
      activities,
      tableStats,
      roles,
      extensions,
    };
  } catch (error) {
    return emptyPayload(formatPgError(error));
  }
}

export async function signalPostgresBackend(input: {
  pid: number;
  mode: "cancel" | "terminate";
}): Promise<{ ok: boolean; signalled?: boolean; error?: string }> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    return {
      ok: false,
      error: "PID must be a positive integer.",
    };
  }

  if (input.mode !== "cancel" && input.mode !== "terminate") {
    return {
      ok: false,
      error: 'Signal mode must be "cancel" or "terminate".',
    };
  }

  try {
    const pool = getPool();
    const res = await pool.query<{ is_self: boolean; signalled: boolean }>(
      `SELECT
         ($1::int = pg_backend_pid()) AS is_self,
         CASE
           WHEN $1::int = pg_backend_pid() THEN false
           WHEN $2::text = 'cancel' THEN pg_cancel_backend($1::int)
           ELSE pg_terminate_backend($1::int)
         END AS signalled`,
      [input.pid, input.mode]
    );

    const row = res.rows[0];
    if (row?.is_self) {
      return {
        ok: false,
        signalled: false,
        error: "Refusing to signal the active PGSA backend connection.",
      };
    }

    if (!row?.signalled) {
      return {
        ok: false,
        signalled: false,
        error: `Could not ${input.mode} backend PID ${input.pid} (process may have exited or lacks permission).`,
      };
    }

    return { ok: true, signalled: true };
  } catch (error) {
    return {
      ok: false,
      error: formatPgError(error),
    };
  }
}

export async function pingPostgres(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const startedAt = performance.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const pool = getPool();
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("PostgreSQL health ping timed out.")),
          2500
        );
      }),
    ]);

    return {
      ok: true,
      latencyMs: Math.max(
        0,
        Math.round((performance.now() - startedAt) * 100) / 100
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatPgError(error),
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
