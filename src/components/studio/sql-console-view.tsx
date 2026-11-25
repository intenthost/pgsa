"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  BracesIcon,
  Cancel01Icon,
  Clock01Icon,
  Copy01Icon,
  Download01Icon,
  Loading03Icon,
  PlayIcon,
  SqlIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { runSqlQueryAction } from "@/app/actions";
import { JsonbViewer, formatJsonb } from "@/components/jsonb-viewer";
import { SqlEditor } from "@/components/sql-editor";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  PostgresColumn,
  PostgresRow,
  PostgresValue,
  QueryExecutionResult,
  TableSchema,
} from "@/types/postgres";

export interface SqlConsoleViewProps {
  schemaCatalog: TableSchema[];
  initialSql?: string;
  onJumpToTable?: (schema: string, name: string) => void;
}

interface SqlDiagnosticPreset {
  id: string;
  label: string;
  description: string;
  sql: string;
}

interface SqlHistoryEntry {
  id: string;
  sql: string;
  ok: boolean;
  command: string;
  rowCount: number;
  durationMs: number;
  executedAt: number;
}

interface SortState {
  column: string;
  direction: "asc" | "desc";
}

interface FocusedCell {
  rowIndex: number;
  colIndex: number;
}

interface InspectorState {
  title: string;
  subtitle: string;
  payload: unknown;
}

const HISTORY_STORAGE_KEY = "pgsa.sql_console.history.v1";
const MAX_HISTORY_ITEMS = 20;

const DIAGNOSTIC_PRESETS: readonly SqlDiagnosticPreset[] = [
  {
    id: "active-backends",
    label: "Active Backends",
    description: "pg_stat_activity",
    sql: `SELECT pid,
       usename,
       application_name,
       state,
       wait_event_type,
       ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 2) AS duration_s,
       LEFT(query, 120) AS query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY query_start DESC NULLS LAST;`,
  },
  {
    id: "table-sizes",
    label: "Table Sizes",
    description: "pg_total_relation_size",
    sql: `SELECT n.nspname AS schema,
       c.relname AS table_name,
       GREATEST(COALESCE(c.reltuples, 0)::bigint, COALESCE(pg_stat_get_live_tuples(c.oid), 0), 0) AS est_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_size_pretty(pg_relation_size(c.oid)) AS table_size,
       pg_size_pretty(pg_indexes_size(c.oid)) AS index_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC;`,
  },
  {
    id: "unused-indexes",
    label: "Unused Indexes",
    description: "idx_scan = 0",
    sql: `SELECT schemaname AS schema,
       relname AS table_name,
       indexrelname AS index_name,
       idx_scan AS scans,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelid NOT IN (
    SELECT conindid FROM pg_constraint WHERE contype IN ('p', 'u')
  )
ORDER BY pg_relation_size(indexrelid) DESC;`,
  },
  {
    id: "cache-hit-ratio",
    label: "Cache Hit Ratio",
    description: "pg_stat_database",
    sql: `SELECT datname AS database,
       blks_hit,
       blks_read,
       CASE
         WHEN (blks_hit + blks_read) = 0 THEN 100.00
         ELSE ROUND((blks_hit::numeric / (blks_hit + blks_read)) * 100, 2)
       END AS cache_hit_pct
FROM pg_stat_database
WHERE datname = current_database();`,
  },
] as const;

const DEFAULT_CONSOLE_SQL = `SELECT current_database() AS database,
       current_user AS role,
       version() AS postgres_version;`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildFallbackSql(catalog: TableSchema[]): string {
  if (catalog.length > 0) {
    const t = catalog[0];
    return `SELECT * FROM ${quoteIdentifier(t.schema)}.${quoteIdentifier(t.name)} LIMIT 50;`;
  }
  return DEFAULT_CONSOLE_SQL;
}

const EMPTY_HISTORY: SqlHistoryEntry[] = [];
const historySubscribers = new Set<() => void>();
let cachedHistoryRaw: string | null = null;
let cachedHistoryParsed: SqlHistoryEntry[] = EMPTY_HISTORY;

function subscribeHistory(listener: () => void): () => void {
  historySubscribers.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === HISTORY_STORAGE_KEY) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    historySubscribers.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getHistorySnapshot(): SqlHistoryEntry[] {
  if (typeof window === "undefined") return EMPTY_HISTORY;
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw === cachedHistoryRaw) {
      return cachedHistoryParsed;
    }
    cachedHistoryRaw = raw;
    if (!raw) {
      cachedHistoryParsed = EMPTY_HISTORY;
      return cachedHistoryParsed;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cachedHistoryParsed = EMPTY_HISTORY;
      return cachedHistoryParsed;
    }
    cachedHistoryParsed = parsed
      .filter(
        (item): item is SqlHistoryEntry =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as SqlHistoryEntry).sql === "string" &&
          typeof (item as SqlHistoryEntry).id === "string"
      )
      .slice(0, MAX_HISTORY_ITEMS);
    return cachedHistoryParsed;
  } catch {
    return EMPTY_HISTORY;
  }
}

function getServerHistorySnapshot(): SqlHistoryEntry[] {
  return EMPTY_HISTORY;
}

function saveHistoryToStorage(entries: SqlHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    const serialized = JSON.stringify(entries);
    cachedHistoryRaw = serialized;
    cachedHistoryParsed = entries;
    window.localStorage.setItem(HISTORY_STORAGE_KEY, serialized);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
  for (const listener of historySubscribers) {
    listener();
  }
}

export function clearSqlHistoryStorage(): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }
  cachedHistoryRaw = null;
  cachedHistoryParsed = EMPTY_HISTORY;
  for (const listener of historySubscribers) {
    listener();
  }
}

function stripLeadingExplain(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const withoutExplain = trimmed.replace(/^EXPLAIN\s*(\([^)]*\))?\s*/i, "");
  return withoutExplain.trim();
}

function extractExplainPayload(
  result: QueryExecutionResult | null
): unknown | null {
  if (!result || !result.ok || result.rows.length === 0) return null;
  if (result.columns.length !== 1) return null;
  const colName = result.columns[0].name;
  if (colName.toUpperCase() !== "QUERY PLAN") return null;

  const firstVal = result.rows[0][colName];
  if (firstVal !== null && typeof firstVal === "object") {
    return firstVal;
  }
  if (typeof firstVal === "string") {
    const trimmed = firstVal.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface ExplainMetrics {
  nodeType?: string;
  planningTimeMs?: number;
  executionTimeMs?: number;
  actualRows?: number;
}

function extractExplainMetrics(payload: unknown): ExplainMetrics {
  const root = Array.isArray(payload) ? payload[0] : payload;
  if (!root || typeof root !== "object") return {};
  const record = root as Record<string, unknown>;
  const plan =
    record.Plan && typeof record.Plan === "object"
      ? (record.Plan as Record<string, unknown>)
      : undefined;

  return {
    nodeType: typeof plan?.["Node Type"] === "string" ? plan["Node Type"] : undefined,
    planningTimeMs:
      typeof record["Planning Time"] === "number"
        ? record["Planning Time"]
        : undefined,
    executionTimeMs:
      typeof record["Execution Time"] === "number"
        ? record["Execution Time"]
        : undefined,
    actualRows:
      typeof plan?.["Actual Rows"] === "number"
        ? plan["Actual Rows"]
        : undefined,
  };
}

function isJsonbColumnValue(
  column: PostgresColumn,
  value: PostgresValue
): boolean {
  if (value === null) return false;
  const lower = column.dataType.toLowerCase();
  return (
    lower === "jsonb" ||
    lower === "json" ||
    (typeof value === "object" && !Array.isArray(value))
  );
}

function isNumericDataType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return (
    lower === "int2" ||
    lower === "int4" ||
    lower === "int8" ||
    lower === "float4" ||
    lower === "float8" ||
    lower === "numeric" ||
    lower === "oid"
  );
}

function isStatusColumn(column: PostgresColumn, value: PostgresValue): boolean {
  if (typeof value !== "string") return false;
  const colName = column.name.toLowerCase();
  if (colName !== "status" && colName !== "state") return false;
  return value.trim().length > 0 && value.trim().length <= 32;
}

function getStatusDotClass(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "active":
    case "completed":
    case "healthy":
    case "enabled":
    case "online":
    case "success":
    case "idle":
      return status.trim().toLowerCase() === "idle"
        ? "bg-amber-500"
        : "bg-emerald-500";
    case "pending":
    case "warning":
    case "waiting":
      return "bg-amber-500";
    case "failed":
    case "error":
    case "disabled":
    case "closed":
      return "bg-rose-500";
    default:
      return "bg-zinc-400";
  }
}

function summarizeJsonValue(val: PostgresValue): string {
  if (Array.isArray(val)) {
    return `[${val.length} ${val.length === 1 ? "item" : "items"}]`;
  }
  if (val !== null && typeof val === "object") {
    const keys = Object.keys(val);
    return `{${keys.length} ${keys.length === 1 ? "key" : "keys"}}`;
  }
  return String(val);
}

function stringifyCellForCopy(value: PostgresValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function escapeCsvCell(value: PostgresValue): string {
  if (value === null || value === undefined) return "";
  let raw =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (
    typeof value === "string" &&
    (/^[=+\-@\t\r]/.test(raw) || /^[=+\-@]/.test(raw.trimStart()))
  ) {
    raw = `'${raw}`;
  }
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function compareCellValues(
  a: PostgresValue,
  b: PostgresValue,
  direction: "asc" | "desc"
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  let cmp = 0;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    cmp = Number(a) - Number(b);
  } else {
    const strA = typeof a === "object" ? JSON.stringify(a) : String(a);
    const strB = typeof b === "object" ? JSON.stringify(b) : String(b);
    cmp = strA.localeCompare(strB, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  return direction === "asc" ? cmp : -cmp;
}

function splitQualifiedTable(sourceTable: string): {
  schema: string;
  name: string;
} {
  const idx = sourceTable.indexOf(".");
  if (idx === -1) {
    return { schema: "public", name: sourceTable };
  }
  return {
    schema: sourceTable.slice(0, idx),
    name: sourceTable.slice(idx + 1),
  };
}

export function SqlConsoleView({
  schemaCatalog,
  initialSql,
  onJumpToTable,
}: SqlConsoleViewProps) {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);

  const [prevInitialSql, setPrevInitialSql] = useState(initialSql);
  const [sql, setSql] = useState<string>(
    () => initialSql ?? buildFallbackSql(schemaCatalog)
  );
  if (initialSql !== prevInitialSql) {
    setPrevInitialSql(initialSql);
    if (initialSql !== undefined) {
      setSql(initialSql);
    }
  }

  const [result, setResult] = useState<QueryExecutionResult | null>(null);
  const [wasExplainRun, setWasExplainRun] = useState<boolean>(false);
  const history = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getServerHistorySnapshot
  );
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  const [inspector, setInspector] = useState<InspectorState | null>(null);
  const [editorHeight, setEditorHeight] = useState<number>(220);

  const [isExecuting, startExecuteTransition] = useTransition();

  const editorSchemaMap = useMemo<Record<string, readonly string[]>>(() => {
    const map: Record<string, readonly string[]> = {};
    for (const table of schemaCatalog) {
      map[`${table.schema}.${table.name}`] = table.columns.map(
        (col) => col.name
      );
    }
    return map;
  }, [schemaCatalog]);

  const recordHistory = useCallback(
    (executedSql: string, res: QueryExecutionResult) => {
      const normalized = executedSql.trim();
      if (!normalized) return;
      const prev = getHistorySnapshot();
      const entry: SqlHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sql: normalized,
        ok: res.ok,
        command: res.command,
        rowCount: res.rowCount,
        durationMs: res.durationMs,
        executedAt: Date.now(),
      };
      const deduped = prev.filter((item) => item.sql !== normalized);
      const next = [entry, ...deduped].slice(0, MAX_HISTORY_ITEMS);
      saveHistoryToStorage(next);
    },
    []
  );

  const executeQuery = useCallback(
    (sqlToRun: string, options?: { isExplain?: boolean; skipHistory?: boolean }) => {
      const trimmed = sqlToRun.trim();
      if (!trimmed) {
        toast.info("Enter a SQL query to run");
        return;
      }

      startExecuteTransition(async () => {
        try {
          const res = await runSqlQueryAction(trimmed);
          setResult(res);
          setWasExplainRun(Boolean(options?.isExplain));
          setSortState(null);
          setFocusedCell(null);

          if (!options?.skipHistory) {
            recordHistory(trimmed, res);
          }

          if (!res.ok) {
            toast.error("Query failed", {
              description: res.error ?? "Check SQL syntax.",
            });
          }
        } catch (err) {
          toast.error("Failed to run SQL query", {
            description:
              err instanceof Error ? err.message : "Server action error.",
          });
        }
      });
    },
    [recordHistory]
  );

  const handleExplainQuery = useCallback(() => {
    const inner = stripLeadingExplain(sql);
    if (!inner) {
      toast.info("Enter a SQL statement to explain");
      return;
    }
    const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${inner};`;
    executeQuery(explainSql, { isExplain: true, skipHistory: true });
  }, [executeQuery, sql]);

  const handleCopyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error(`Clipboard unavailable for ${label}`);
    }
  }, []);

  const handleClearHistory = useCallback(() => {
    clearSqlHistoryStorage();
  }, []);

  const handleSplitterPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = editorHeight;
      const containerHeight = workbenchRef.current?.clientHeight ?? 680;
      const maxHeight = Math.max(180, Math.floor(containerHeight * 0.65));

      const handleMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const clamped = Math.min(maxHeight, Math.max(120, startHeight + delta));
        setEditorHeight(clamped);
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [editorHeight]
  );

  const explainPayload = useMemo(() => extractExplainPayload(result), [result]);
  const explainMetrics = useMemo(
    () => (explainPayload ? extractExplainMetrics(explainPayload) : {}),
    [explainPayload]
  );

  const columns = useMemo(() => result?.columns ?? [], [result?.columns]);
  const sortedRows = useMemo(() => {
    const rows = result?.rows ?? [];
    if (!sortState) return rows;
    return [...rows].sort((a, b) =>
      compareCellValues(
        a[sortState.column] ?? null,
        b[sortState.column] ?? null,
        sortState.direction
      )
    );
  }, [result?.rows, sortState]);

  const focusGridCell = useCallback((rowIndex: number, colIndex: number) => {
    setFocusedCell({ rowIndex, colIndex });
    requestAnimationFrame(() => {
      const el = tableContainerRef.current?.querySelector<HTMLElement>(
        `[data-sql-cell="${rowIndex}:${colIndex}"]`
      );
      el?.focus();
    });
  }, []);

  const handleCellKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTableCellElement>,
      rowIndex: number,
      colIndex: number,
      column: PostgresColumn,
      row: PostgresRow
    ) => {
      const maxRow = sortedRows.length - 1;
      const maxCol = columns.length - 1;
      if (maxRow < 0 || maxCol < 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusGridCell(Math.min(maxRow, rowIndex + 1), colIndex);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusGridCell(Math.max(0, rowIndex - 1), colIndex);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        focusGridCell(rowIndex, Math.min(maxCol, colIndex + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        focusGridCell(rowIndex, Math.max(0, colIndex - 1));
      } else if (e.key === "Enter") {
        const val = row[column.name] ?? null;
        if (isJsonbColumnValue(column, val)) {
          e.preventDefault();
          setInspector({
            title: `${column.name} (${column.dataType})`,
            subtitle: `Row #${rowIndex + 1}`,
            payload: val,
          });
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        const selection = window.getSelection()?.toString();
        if (!selection) {
          e.preventDefault();
          void handleCopyText(
            stringifyCellForCopy(row[column.name] ?? null),
            column.name
          );
        }
      }
    },
    [columns, focusGridCell, handleCopyText, sortedRows.length]
  );

  const handleExportCsv = useCallback(() => {
    if (columns.length === 0 || sortedRows.length === 0) return;
    const header = columns.map((c) => escapeCsvCell(c.name)).join(",");
    const body = sortedRows.map((r) =>
      columns.map((c) => escapeCsvCell(r[c.name] ?? null)).join(",")
    );
    const blob = new Blob([[header, ...body].join("\r\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "query_result.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${sortedRows.length} rows as CSV`);
  }, [columns, sortedRows]);

  const handleExportJson = useCallback(() => {
    if (sortedRows.length === 0) return;
    const blob = new Blob([formatJsonb(sortedRows)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "query_result.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${sortedRows.length} rows as JSON`);
  }, [sortedRows]);

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-1 overflow-hidden bg-white text-zinc-900">
        {/* Left 220px Compact Rail: Diagnostics + Recent History */}
        <aside className="flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-zinc-50/60">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-200 px-3">
            <span className="text-xs font-medium text-zinc-700">Console</span>
            <span className="text-[11px] text-zinc-600 tabular-nums">
              {schemaCatalog.length} tables
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* Diagnostic Presets */}
            <div className="flex flex-col gap-0.5 border-b border-zinc-200 px-2 py-2.5">
              <div className="px-1.5 pb-1 text-[11px] font-medium text-zinc-600">
                Diagnostics
              </div>
              {DIAGNOSTIC_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setSql(preset.sql);
                    executeQuery(preset.sql, { skipHistory: true });
                  }}
                  className="group flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-100"
                >
                  <span className="text-xs font-medium text-zinc-800 group-hover:text-zinc-950">
                    {preset.label}
                  </span>
                  <span className="truncate font-mono text-[11px] text-zinc-500">
                    {preset.description}
                  </span>
                </button>
              ))}
            </div>

            {/* Recent Query History */}
            <div className="flex min-h-0 flex-1 flex-col gap-1 px-2 py-2.5">
              <div className="flex items-center justify-between px-1.5">
                <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-600">
                  <HugeiconsIcon icon={Clock01Icon} className="size-3" />
                  History
                </span>
                {history.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-5 px-1.5 text-[11px] text-zinc-600"
                    onClick={handleClearHistory}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="px-1.5 py-4 text-[11px] text-zinc-500">
                  Executed queries appear here.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSql(item.sql)}
                      title={item.sql}
                      className="group flex w-full flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-zinc-200 hover:bg-white"
                    >
                      <span className="line-clamp-2 font-mono text-[11px] leading-snug text-zinc-700 group-hover:text-zinc-950">
                        {item.sql}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 tabular-nums">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            item.ok ? "bg-emerald-500" : "bg-rose-500"
                          )}
                        />
                        <span>
                          {item.command} · {item.rowCount}r · {item.durationMs}ms
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Main Right Workbench */}
        <div
          ref={workbenchRef}
          className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white"
        >
          {/* Top Toolbar */}
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-7 bg-zinc-900 text-white hover:bg-zinc-800"
                disabled={isExecuting || !sql.trim()}
                onClick={() => executeQuery(sql)}
              >
                <HugeiconsIcon
                  icon={isExecuting ? Loading03Icon : PlayIcon}
                  data-icon="inline-start"
                  className={cn(isExecuting && "animate-spin")}
                />
                Run
                <kbd className="ml-0.5 font-mono text-[11px] font-normal text-zinc-300">
                  ⌘↵
                </kbd>
              </Button>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={isExecuting || !sql.trim()}
                      onClick={handleExplainQuery}
                    />
                  }
                >
                  EXPLAIN
                </TooltipTrigger>
                <TooltipContent>
                  EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                </TooltipContent>
              </Tooltip>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-zinc-600"
                disabled={!sql.trim()}
                onClick={() => void handleCopyText(sql, "SQL")}
              >
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                Copy
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-zinc-600"
                disabled={!sql.trim()}
                onClick={() => setSql("")}
              >
                <HugeiconsIcon icon={Cancel01Icon} data-icon="inline-start" />
                Clear
              </Button>
            </div>

            <div className="flex min-w-0 items-center gap-2.5 text-xs text-zinc-500 tabular-nums">
              {isExecuting ? (
                <span className="flex items-center gap-1.5 text-zinc-500">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="size-3.5 animate-spin"
                  />
                  Executing...
                </span>
              ) : result ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        result.ok ? "bg-emerald-500" : "bg-rose-500"
                      )}
                    />
                    <span>
                      {wasExplainRun ? "EXPLAIN" : result.command} ·{" "}
                      {result.rowCount}{" "}
                      {result.rowCount === 1 ? "row" : "rows"} ·{" "}
                      {result.durationMs} ms
                    </span>
                  </span>

                  {result.sourceTable && onJumpToTable && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-6 text-[11px]"
                      onClick={() => {
                        const target = splitQualifiedTable(result.sourceTable!);
                        onJumpToTable(target.schema, target.name);
                      }}
                    >
                      Open {result.sourceTable}
                    </Button>
                  )}

                  {sortedRows.length > 0 && !explainPayload && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="h-6 text-[11px]"
                          />
                        }
                      >
                        <HugeiconsIcon
                          icon={Download01Icon}
                          data-icon="inline-start"
                        />
                        Export
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Export result</DropdownMenuLabel>
                          <DropdownMenuItem onClick={handleExportCsv}>
                            CSV (.csv)
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleExportJson}>
                            JSON (.json)
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </>
              ) : (
                <span className="text-zinc-500">PostgreSQL ready</span>
              )}
            </div>
          </div>

          {/* Middle Light SqlEditor */}
          <div
            style={{ height: editorHeight }}
            className="shrink-0 overflow-hidden bg-white"
          >
            <SqlEditor
              value={sql}
              onChange={setSql}
              onExecute={(currentSql) => executeQuery(currentSql)}
              schema={editorSchemaMap}
              placeholder="Write PostgreSQL query... (⌘↵ to run)"
              className="h-full rounded-none border-0 focus-within:border-transparent focus-within:ring-0"
            />
          </div>

          {/* Drag Resize Handle */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize SQL editor"
            onPointerDown={handleSplitterPointerDown}
            className="h-1.5 shrink-0 cursor-row-resize border-y border-zinc-200 bg-zinc-50 transition-colors hover:bg-zinc-200"
          />

          {/* Bottom Edge-to-Edge Results */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
            {result && !result.ok && result.error && (
              <div className="flex items-start gap-2 border-b border-rose-200 bg-rose-50/70 px-3 py-2 text-xs text-rose-800">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  className="mt-0.5 size-3.5 shrink-0 text-rose-600"
                />
                <span className="font-mono break-all">{result.error}</span>
              </div>
            )}

            {result?.notice && (
              <div className="border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600">
                {result.notice}
              </div>
            )}

            {explainPayload ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 text-xs text-zinc-600 tabular-nums">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-zinc-900">
                      Execution Plan (JSON)
                    </span>
                    {explainMetrics.nodeType && (
                      <span className="font-mono text-[11px] text-zinc-500">
                        {explainMetrics.nodeType}
                      </span>
                    )}
                    {explainMetrics.planningTimeMs !== undefined && (
                      <span>Plan {explainMetrics.planningTimeMs} ms</span>
                    )}
                    {explainMetrics.executionTimeMs !== undefined && (
                      <span>Exec {explainMetrics.executionTimeMs} ms</span>
                    )}
                    {explainMetrics.actualRows !== undefined && (
                      <span>Actual {explainMetrics.actualRows} rows</span>
                    )}
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 text-[11px]"
                    onClick={() =>
                      void handleCopyText(
                        formatJsonb(explainPayload),
                        "EXPLAIN plan JSON"
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={Copy01Icon}
                      data-icon="inline-start"
                    />
                    Copy JSON
                  </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">
                  <JsonbViewer
                    value={explainPayload}
                    readOnly
                    className="h-full rounded-none border-0"
                  />
                </div>
              </div>
            ) : result ? (
              columns.length > 0 ? (
                <div
                  ref={tableContainerRef}
                  className="min-h-0 flex-1 overflow-auto bg-white"
                >
                  <table className="w-full border-separate border-spacing-0 text-left font-sans">
                    <thead className="sticky top-0 z-20 bg-zinc-50 text-xs">
                      <tr className="h-8">
                        <th
                          scope="col"
                          className="sticky left-0 z-30 h-8 w-11 min-w-11 border-r border-b border-zinc-200 bg-zinc-50 px-2 text-right font-mono text-[11px] font-medium text-zinc-500 tabular-nums select-none"
                        >
                          #
                        </th>
                        {columns.map((col) => {
                          const isSorted = sortState?.column === col.name;
                          return (
                            <th
                              key={col.name}
                              scope="col"
                              className="h-8 border-r border-b border-zinc-200 bg-zinc-50 px-2.5 font-medium whitespace-nowrap text-zinc-900 select-none last:border-r-0"
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  setSortState((prev) => {
                                    if (!prev || prev.column !== col.name) {
                                      return {
                                        column: col.name,
                                        direction: "asc",
                                      };
                                    }
                                    if (prev.direction === "asc") {
                                      return {
                                        column: col.name,
                                        direction: "desc",
                                      };
                                    }
                                    return null;
                                  })
                                }
                                className="group flex w-full items-center justify-between gap-2 text-left text-xs outline-none"
                              >
                                <span className="flex items-center gap-1.5">
                                  <span className="font-medium text-zinc-900">
                                    {col.name}
                                  </span>
                                  <span className="font-mono text-[11px] font-normal text-zinc-500">
                                    {col.dataType}
                                  </span>
                                </span>
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center",
                                    isSorted
                                      ? "text-zinc-900"
                                      : "text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100"
                                  )}
                                >
                                  <HugeiconsIcon
                                    icon={
                                      isSorted
                                        ? sortState.direction === "asc"
                                          ? ArrowUp01Icon
                                          : ArrowDown01Icon
                                        : ArrowUpDownIcon
                                    }
                                    className="size-3"
                                  />
                                </span>
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>

                    <tbody>
                      {sortedRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={columns.length + 1}
                            className="border-b border-zinc-100 px-4 py-10 text-center text-xs text-zinc-500"
                          >
                            Query returned 0 rows.
                          </td>
                        </tr>
                      ) : (
                        sortedRows.map((row, rowIndex) => (
                          <ContextMenu key={`sql-row-${rowIndex}`}>
                            <ContextMenuTrigger
                              render={
                                <tr className="group/row transition-colors hover:bg-zinc-50/70" />
                              }
                            >
                              <td className="sticky left-0 z-10 h-8 w-11 min-w-11 border-r border-b border-zinc-100 bg-zinc-50/70 px-2 text-right font-mono text-[11px] text-zinc-500 tabular-nums select-none">
                                {rowIndex + 1}
                              </td>
                              {columns.map((column, colIndex) => {
                                const cellVal = row[column.name] ?? null;
                                const isFocused =
                                  focusedCell?.rowIndex === rowIndex &&
                                  focusedCell?.colIndex === colIndex;
                                const isJsonb = isJsonbColumnValue(
                                  column,
                                  cellVal
                                );
                                const isNumeric =
                                  typeof cellVal === "number" ||
                                  (cellVal !== null &&
                                    isNumericDataType(column.dataType));
                                const isStatus = isStatusColumn(
                                  column,
                                  cellVal
                                );

                                return (
                                  <td
                                    key={column.name}
                                    data-sql-cell={`${rowIndex}:${colIndex}`}
                                    tabIndex={0}
                                    onClick={() =>
                                      setFocusedCell({ rowIndex, colIndex })
                                    }
                                    onDoubleClick={() => {
                                      if (isJsonb) {
                                        setInspector({
                                          title: `${column.name} (${column.dataType})`,
                                          subtitle: `Row #${rowIndex + 1}`,
                                          payload: cellVal,
                                        });
                                      }
                                    }}
                                    onContextMenu={() =>
                                      setFocusedCell({ rowIndex, colIndex })
                                    }
                                    onKeyDown={(e) =>
                                      handleCellKeyDown(
                                        e,
                                        rowIndex,
                                        colIndex,
                                        column,
                                        row
                                      )
                                    }
                                    className={cn(
                                      "h-8 max-w-md border-r border-b border-zinc-100 px-2.5 py-1 text-xs whitespace-nowrap outline-none last:border-r-0",
                                      isNumeric && "text-right tabular-nums",
                                      isFocused &&
                                        "bg-zinc-50 ring-2 ring-zinc-900 ring-inset"
                                    )}
                                  >
                                    {cellVal === null ? (
                                      <span className="text-zinc-500 italic select-none">
                                        NULL
                                      </span>
                                    ) : isStatus ? (
                                      <span className="inline-flex items-center gap-1.5 text-zinc-700">
                                        <span
                                          className={cn(
                                            "size-1.5 shrink-0 rounded-full",
                                            getStatusDotClass(String(cellVal))
                                          )}
                                        />
                                        <span>{String(cellVal)}</span>
                                      </span>
                                    ) : isJsonb ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setFocusedCell({ rowIndex, colIndex });
                                          setInspector({
                                            title: `${column.name} (${column.dataType})`,
                                            subtitle: `Row #${rowIndex + 1}`,
                                            payload: cellVal,
                                          });
                                        }}
                                        className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900"
                                      >
                                        <HugeiconsIcon
                                          icon={BracesIcon}
                                          className="size-3 text-zinc-500"
                                        />
                                        <span>
                                          {summarizeJsonValue(cellVal)}
                                        </span>
                                      </button>
                                    ) : typeof cellVal === "boolean" ? (
                                      <span
                                        className={cn(
                                          "font-mono text-xs",
                                          cellVal
                                            ? "font-medium text-zinc-900"
                                            : "text-zinc-500"
                                        )}
                                      >
                                        {String(cellVal)}
                                      </span>
                                    ) : Array.isArray(cellVal) ? (
                                      <span className="block truncate font-mono text-xs text-zinc-700">
                                        {JSON.stringify(cellVal)}
                                      </span>
                                    ) : (
                                      <span className="block truncate text-zinc-800">
                                        {String(cellVal)}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                            </ContextMenuTrigger>

                            <ContextMenuContent className="w-52">
                              <ContextMenuGroup>
                                <ContextMenuLabel>
                                  Row #{rowIndex + 1}
                                </ContextMenuLabel>
                                <ContextMenuSeparator />
                                {focusedCell?.rowIndex === rowIndex &&
                                  columns[focusedCell.colIndex] && (
                                    <ContextMenuItem
                                      onClick={() => {
                                        const col =
                                          columns[focusedCell.colIndex];
                                        void handleCopyText(
                                          stringifyCellForCopy(
                                            row[col.name] ?? null
                                          ),
                                          col.name
                                        );
                                      }}
                                    >
                                      <HugeiconsIcon icon={Copy01Icon} />
                                      <span>Copy cell</span>
                                      <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                                    </ContextMenuItem>
                                  )}
                                <ContextMenuItem
                                  onClick={() =>
                                    setInspector({
                                      title: "Row Payload",
                                      subtitle: `Row #${rowIndex + 1}`,
                                      payload: row,
                                    })
                                  }
                                >
                                  <HugeiconsIcon icon={ViewIcon} />
                                  <span>Inspect Row JSON</span>
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() =>
                                    void handleCopyText(
                                      formatJsonb(row),
                                      `Row #${rowIndex + 1} JSON`
                                    )
                                  }
                                >
                                  <HugeiconsIcon icon={BracesIcon} />
                                  <span>Copy row JSON</span>
                                </ContextMenuItem>
                              </ContextMenuGroup>
                            </ContextMenuContent>
                          </ContextMenu>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-12 text-center text-xs text-zinc-500">
                  <span className="font-medium text-zinc-800">
                    {result.command} completed
                  </span>
                  <span className="tabular-nums">
                    {result.rowCount}{" "}
                    {result.rowCount === 1 ? "row" : "rows"} affected ·{" "}
                    {result.durationMs} ms
                  </span>
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
                <HugeiconsIcon
                  icon={SqlIcon}
                  className="size-6 text-zinc-500"
                  strokeWidth={1.6}
                />
                <p className="text-sm font-medium text-zinc-900">
                  SQL Console
                </p>
                <p className="max-w-sm text-xs text-zinc-500">
                  Run ad-hoc PostgreSQL queries with live schema autocomplete,
                  inspect EXPLAIN plans, or choose a diagnostic preset.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Read-only JSONB / Row Inspector Dialog */}
        <Dialog
          open={Boolean(inspector)}
          onOpenChange={(open) => {
            if (!open) setInspector(null);
          }}
        >
          <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl">
            <DialogHeader className="gap-1">
              <DialogTitle>{inspector?.title ?? "JSON Inspector"}</DialogTitle>
              <DialogDescription className="text-xs">
                {inspector?.subtitle}
              </DialogDescription>
            </DialogHeader>

            <div className="h-[380px] min-h-0 flex-1 overflow-hidden">
              <JsonbViewer
                value={inspector?.payload ?? null}
                readOnly
                className="h-full"
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void handleCopyText(
                    formatJsonb(inspector?.payload ?? null),
                    inspector?.title ?? "JSON"
                  )
                }
              >
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                Copy JSON
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

export default SqlConsoleView;
