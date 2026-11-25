"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  Alert02Icon,
  BracesIcon,
  Cancel01Icon,
  CommandIcon,
  Copy01Icon,
  Database02Icon,
  DatabaseExportIcon,
  GridTableIcon,
  HierarchyIcon,
  Logout03Icon,
  RefreshIcon,
  Search01Icon,
  ServerStack01Icon,
  SidebarLeftIcon,
  SqlIcon,
  Table01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import {
  browseTableAction,
  logoutAction,
  runSqlQueryAction,
} from "@/app/actions";
import { JsonbViewer, formatJsonb } from "@/components/jsonb-viewer";
import { ActivityStatsView } from "@/components/studio/activity-stats-view";
import { BackupRestoreView } from "@/components/studio/backup-restore-view";
import {
  DataGridView,
  type DataGridServerPagination,
  type SortState,
} from "@/components/studio/data-grid-view";
import { SchemaVisualizerView } from "@/components/studio/schema-visualizer-view";
import {
  SqlConsoleView,
  clearSqlHistoryStorage,
} from "@/components/studio/sql-console-view";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
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
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  QueryExecutionResult,
  QueryTab,
  TableSchema,
} from "@/types/postgres";

export interface ConnectionMeta {
  sessionUser: string;
  database?: string;
  dbUser?: string;
  host?: string;
  port?: string;
  sslMode?: string;
  pgVersion?: string;
}

export interface PgsaWorkbenchProps {
  initialTabs: QueryTab[];
  schemaCatalog: TableSchema[];
  initialResult: QueryExecutionResult;
  catalogError?: string;
  connectionMeta: ConnectionMeta;
}

type StudioView = "tables" | "sql" | "visualizer" | "backup" | "activity";

interface BrowseParams {
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  sort: SortState | null;
  search: string;
}

interface HealthResponse {
  ok: boolean;
  stack: string;
  envConfigured?: boolean;
  dbConnected?: boolean;
  timestamp: string;
}

interface HealthState {
  status: "checking" | "healthy" | "degraded" | "error";
  stack?: string;
  envConfigured?: boolean;
  dbConnected?: boolean;
  timestamp?: string;
  latencyMs?: number;
  error?: string;
}

interface SchemaInspectorState {
  title: string;
  subtitle: string;
  payload: unknown;
}

const DEFAULT_PAGE_SIZE = 50;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildQualifiedSelectSql(schema: string, tableName: string): string {
  return `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(tableName)} LIMIT 50;`;
}

function formatUtcTimestamp(isoValue: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(isoValue)) {
    return `${isoValue.slice(0, 19).replace("T", " ")} UTC`;
  }
  return isoValue;
}

async function fetchHealthStatus(signal?: AbortSignal): Promise<HealthState> {
  const startedAt = performance.now();
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as HealthResponse;
    if (!payload.ok) {
      throw new Error("Health endpoint returned ok=false");
    }
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const healthy =
      payload.dbConnected !== false && payload.envConfigured !== false;
    return {
      status: healthy ? "healthy" : "degraded",
      stack: payload.stack,
      envConfigured: payload.envConfigured,
      dbConnected: payload.dbConnected,
      timestamp: payload.timestamp,
      latencyMs,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Health check failed",
    };
  }
}

export function PgsaWorkbench({
  initialTabs,
  schemaCatalog,
  initialResult,
  catalogError,
  connectionMeta,
}: PgsaWorkbenchProps) {
  const router = useRouter();
  const requestSeqRef = useRef<number>(0);

  const firstTable = schemaCatalog[0] ?? null;

  const [activeView, setActiveView] = useState<StudioView>("tables");
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  const [sidebarSearch, setSidebarSearch] = useState<string>("");
  const [isCommandOpen, setIsCommandOpen] = useState<boolean>(false);
  const [isBannerDismissed, setIsBannerDismissed] = useState<boolean>(false);

  const [rowEstimateOverrides, setRowEstimateOverrides] = useState<
    Record<string, number>
  >({});

  const catalog = useMemo<TableSchema[]>(
    () =>
      schemaCatalog.map((table) => {
        const key = `${table.schema}.${table.name}`;
        const override = rowEstimateOverrides[key];
        return override !== undefined
          ? { ...table, rowEstimate: override }
          : table;
      }),
    [schemaCatalog, rowEstimateOverrides]
  );

  const [browseParams, setBrowseParams] = useState<BrowseParams>(() => ({
    schema: firstTable?.schema ?? "",
    table: firstTable?.name ?? "",
    page: initialResult.page ?? 1,
    pageSize: initialResult.pageSize ?? DEFAULT_PAGE_SIZE,
    sort: null,
    search: "",
  }));

  const [tableResult, setTableResult] =
    useState<QueryExecutionResult>(initialResult);
  const [sqlConsoleDraft, setSqlConsoleDraft] = useState<string>(
    () =>
      initialTabs[0]?.sql ??
      (firstTable
        ? buildQualifiedSelectSql(firstTable.schema, firstTable.name)
        : "SELECT version(), current_database(), current_user;")
  );

  const [schemaInspector, setSchemaInspector] =
    useState<SchemaInspectorState | null>(null);
  const [health, setHealth] = useState<HealthState>({ status: "checking" });

  const [isBrowsing, startBrowseTransition] = useTransition();
  const [isSigningOut, startSignOutTransition] = useTransition();

  const activeTable = useMemo<TableSchema | null>(() => {
    if (!browseParams.schema || !browseParams.table) return null;
    return (
      catalog.find(
        (t) =>
          t.schema === browseParams.schema && t.name === browseParams.table
      ) ?? null
    );
  }, [catalog, browseParams.schema, browseParams.table]);

  const filteredCatalog = useMemo(() => {
    const term = sidebarSearch.trim().toLowerCase();
    if (!term) return catalog;
    return catalog.filter((table) => {
      const fullName = `${table.schema}.${table.name}`.toLowerCase();
      return (
        table.name.toLowerCase().includes(term) ||
        table.schema.toLowerCase().includes(term) ||
        fullName.includes(term)
      );
    });
  }, [catalog, sidebarSearch]);

  const totalCatalogRows = useMemo(
    () => catalog.reduce((acc, tbl) => acc + tbl.rowEstimate, 0),
    [catalog]
  );

  const handlePingHealth = useCallback(async (notifyOnDone = false) => {
    setHealth((prev) => ({ ...prev, status: "checking", error: undefined }));
    try {
      const nextHealth = await fetchHealthStatus();
      setHealth(nextHealth);
      if (notifyOnDone) {
        if (nextHealth.status === "healthy") {
          toast.success("PostgreSQL health check passed", {
            description: `${nextHealth.stack ?? "pgsa"} · ${nextHealth.latencyMs ?? 1} ms`,
          });
        } else if (nextHealth.status === "degraded") {
          toast.warning("App healthy, PostgreSQL unreachable", {
            description: "Check DATABASE_URL and PostgreSQL service status.",
          });
        } else {
          toast.error("Health check failed", {
            description: nextHealth.error ?? "Unavailable",
          });
        }
      }
    } catch {
      // Ignore abort
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealthStatus(controller.signal)
      .then((nextHealth) => {
        if (!controller.signal.aborted) {
          setHealth(nextHealth);
        }
      })
      .catch(() => {
        // Request aborted on unmount
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCopyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label} to clipboard`);
    } catch {
      toast.error(`Clipboard unavailable for ${label}`);
    }
  }, []);

  const fetchTablePage = useCallback((nextParams: BrowseParams) => {
    if (!nextParams.schema || !nextParams.table) return;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setBrowseParams(nextParams);

    startBrowseTransition(async () => {
      try {
        const res = await browseTableAction({
          schema: nextParams.schema,
          table: nextParams.table,
          page: nextParams.page,
          pageSize: nextParams.pageSize,
          sortColumn: nextParams.sort?.column,
          sortDirection: nextParams.sort?.direction,
          search: nextParams.search || undefined,
        });

        if (requestSeqRef.current !== seq) return;

        setTableResult(res);

        if (
          res.ok &&
          res.totalRows !== undefined &&
          !nextParams.search.trim()
        ) {
          const tableKey = `${nextParams.schema}.${nextParams.table}`;
          const exactCount = res.totalRows;
          setRowEstimateOverrides((prev) => ({
            ...prev,
            [tableKey]: exactCount,
          }));
        }

        if (!res.ok) {
          toast.error(`Failed to browse ${nextParams.schema}.${nextParams.table}`, {
            description: res.error ?? "Database query failed.",
          });
        }
      } catch (err) {
        if (requestSeqRef.current !== seq) return;
        toast.error("Failed to load table rows", {
          description:
            err instanceof Error ? err.message : "Server action failed.",
        });
      }
    });
  }, []);

  const handleSelectTable = useCallback(
    (schema: string, table: string) => {
      const nextParams: BrowseParams = {
        schema,
        table,
        page: 1,
        pageSize: browseParams.pageSize || DEFAULT_PAGE_SIZE,
        sort: null,
        search: "",
      };
      setActiveView("tables");
      fetchTablePage(nextParams);
    },
    [browseParams.pageSize, fetchTablePage]
  );

  const handleRefreshTable = useCallback(() => {
    if (browseParams.schema && browseParams.table) {
      fetchTablePage(browseParams);
      return;
    }

    startBrowseTransition(async () => {
      const sqlToRun =
        initialTabs[0]?.sql ??
        "SELECT version(), current_database(), current_user;";
      const res = await runSqlQueryAction(sqlToRun);
      setTableResult(res);
    });
  }, [browseParams, fetchTablePage, initialTabs]);

  const handleResultUpdated = useCallback(
    (updater: (prev: QueryExecutionResult) => QueryExecutionResult) => {
      setTableResult((prev) => {
        const next = updater(prev);
        if (
          browseParams.schema &&
          browseParams.table &&
          !browseParams.search.trim() &&
          next.totalRows !== undefined &&
          next.totalRows !== prev.totalRows
        ) {
          const tableKey = `${browseParams.schema}.${browseParams.table}`;
          const nextTotal = next.totalRows;
          setRowEstimateOverrides((overrides) => ({
            ...overrides,
            [tableKey]: nextTotal,
          }));
        }
        return next;
      });
    },
    [browseParams.schema, browseParams.search, browseParams.table]
  );

  const handleOpenSqlTab = useCallback(
    (initialSql?: string) => {
      const fallback = activeTable
        ? buildQualifiedSelectSql(activeTable.schema, activeTable.name)
        : "SELECT version(), current_database(), current_user;";
      setSqlConsoleDraft(initialSql ?? fallback);
      setActiveView("sql");
    },
    [activeTable]
  );

  const serverPagination = useMemo<DataGridServerPagination | undefined>(() => {
    if (!activeTable) return undefined;
    const totalRows =
      tableResult.totalRows ?? tableResult.rowCount ?? activeTable.rowEstimate;

    return {
      page: tableResult.page ?? browseParams.page,
      pageSize: tableResult.pageSize ?? browseParams.pageSize,
      totalRows,
      search: browseParams.search,
      sort: browseParams.sort,
      onPageChange: (nextPage) => {
        fetchTablePage({ ...browseParams, page: nextPage });
      },
      onPageSizeChange: (nextPageSize) => {
        fetchTablePage({ ...browseParams, page: 1, pageSize: nextPageSize });
      },
      onSortChange: (nextSort) => {
        fetchTablePage({ ...browseParams, page: 1, sort: nextSort });
      },
      onSearchChange: (nextSearch) => {
        fetchTablePage({ ...browseParams, page: 1, search: nextSearch });
      },
    };
  }, [activeTable, browseParams, fetchTablePage, tableResult]);

  const handleSignOut = useCallback(() => {
    clearSqlHistoryStorage();
    startSignOutTransition(() => {
      void logoutAction();
    });
  }, []);

  const activeDbName = connectionMeta.database ?? "PostgreSQL";
  const activeDbUser = connectionMeta.dbUser ?? connectionMeta.sessionUser;

  const statusDotClass = cn(
    "size-1.5 shrink-0 rounded-full",
    health.status === "healthy" && "bg-emerald-500",
    (health.status === "checking" || health.status === "degraded") &&
      "animate-pulse bg-amber-500",
    health.status === "error" && "bg-rose-500"
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background font-sans text-foreground">
        {/* Single 44px Edge-to-Edge Studio Header */}
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3">
          {/* Left: Sidebar Toggle (Tables View) + Brand + Active DB */}
          <div className="flex min-w-0 items-center gap-2">
            {activeView === "tables" && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        isSidebarOpen
                          ? "Hide tables sidebar"
                          : "Show tables sidebar"
                      }
                      onClick={() => setIsSidebarOpen((open) => !open)}
                    />
                  }
                >
                  <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={1.8} />
                </TooltipTrigger>
                <TooltipContent>
                  {isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
                </TooltipContent>
              </Tooltip>
            )}

            <div className="flex items-center gap-2">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white">
                <HugeiconsIcon
                  icon={Database02Icon}
                  size={13}
                  strokeWidth={2}
                />
              </span>
              <span className="text-sm font-semibold tracking-tight text-foreground">
                PGSA
              </span>
            </div>

            <span
              aria-hidden="true"
              className="hidden text-sm text-zinc-500 select-none sm:inline"
            >
              /
            </span>

            <div className="hidden min-w-0 items-center gap-1.5 text-xs sm:flex">
              <span className={statusDotClass} />
              <span className="max-w-36 truncate font-medium text-foreground">
                {activeDbName}
              </span>
              <span className="hidden truncate text-zinc-600 lg:inline">
                ({activeDbUser})
              </span>
            </div>
          </div>

          {/* Center: 5-View Studio Navigation Tabs */}
          <Tabs
            value={activeView}
            onValueChange={(value) => setActiveView(value as StudioView)}
          >
            <TabsList variant="line">
              <TabsTrigger value="tables">
                <HugeiconsIcon icon={Table01Icon} strokeWidth={1.8} />
                <span>Tables</span>
              </TabsTrigger>
              <TabsTrigger value="sql">
                <HugeiconsIcon icon={SqlIcon} strokeWidth={1.8} />
                <span>SQL</span>
              </TabsTrigger>
              <TabsTrigger value="visualizer">
                <HugeiconsIcon icon={HierarchyIcon} strokeWidth={1.8} />
                <span>Visualizer</span>
              </TabsTrigger>
              <TabsTrigger value="backup">
                <HugeiconsIcon icon={DatabaseExportIcon} strokeWidth={1.8} />
                <span>Backup</span>
              </TabsTrigger>
              <TabsTrigger value="activity">
                <HugeiconsIcon icon={Activity01Icon} strokeWidth={1.8} />
                <span>Activity</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Right: ⌘K Quick Jump + Health Popover + User Menu */}
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsCommandOpen(true)}
              className="text-zinc-600"
            >
              <HugeiconsIcon icon={Search01Icon} data-icon="inline-start" />
              <span className="hidden md:inline">Quick Jump</span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] leading-none text-zinc-600">
                ⌘K
              </kbd>
            </Button>

            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Database connection and health"
                    className="text-zinc-600"
                  />
                }
              >
                <span className={statusDotClass} />
                <span className="hidden text-xs tabular-nums sm:inline">
                  {health.latencyMs !== undefined
                    ? `${health.latencyMs}ms`
                    : "Health"}
                </span>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-76">
                <PopoverHeader>
                  <div className="flex items-center justify-between gap-2">
                    <PopoverTitle className="flex items-center gap-1.5 text-[13px] font-semibold">
                      <HugeiconsIcon
                        icon={ServerStack01Icon}
                        size={14}
                        className="text-zinc-600"
                      />
                      <span className="truncate">{activeDbName}</span>
                    </PopoverTitle>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600 capitalize">
                      <span className={statusDotClass} />
                      <span>{health.status}</span>
                    </span>
                  </div>
                  <PopoverDescription className="text-xs text-zinc-600">
                    {connectionMeta.pgVersion ?? "PostgreSQL Live Session"}
                  </PopoverDescription>
                </PopoverHeader>

                <div className="flex flex-col gap-1.5 rounded-md border border-border bg-[#fafafa] p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">Database</span>
                    <span className="truncate font-medium text-foreground">
                      {connectionMeta.database ?? "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">PG Role</span>
                    <span className="truncate font-medium text-foreground">
                      {connectionMeta.dbUser ?? "—"}
                    </span>
                  </div>
                  {connectionMeta.host && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-zinc-600">Host</span>
                      <span className="truncate text-foreground tabular-nums">
                        {connectionMeta.port
                          ? `${connectionMeta.host}:${connectionMeta.port}`
                          : connectionMeta.host}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">Session User</span>
                    <span className="truncate text-foreground">
                      {connectionMeta.sessionUser}
                    </span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">Endpoint</span>
                    <span className="font-mono text-[11px] text-foreground">
                      GET /api/health
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">DB Ping</span>
                    <span className="font-medium text-foreground">
                      {health.dbConnected === true
                        ? "Reachable"
                        : health.dbConnected === false
                          ? "Unreachable"
                          : "Checking…"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">Latency</span>
                    <span className="text-foreground tabular-nums">
                      {health.latencyMs !== undefined
                        ? `${health.latencyMs} ms`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-600">Checked</span>
                    <span className="truncate text-zinc-600 tabular-nums">
                      {health.timestamp
                        ? formatUtcTimestamp(health.timestamp)
                        : health.error ?? "Checking…"}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePingHealth(true)}
                  className="w-full"
                >
                  <HugeiconsIcon
                    icon={RefreshIcon}
                    data-icon="inline-start"
                    className={cn(health.status === "checking" && "animate-spin")}
                  />
                  <span>Check /api/health</span>
                </Button>
              </PopoverContent>
            </Popover>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="ghost" size="sm" />
                }
              >
                <HugeiconsIcon icon={UserIcon} data-icon="inline-start" />
                <span className="hidden max-w-24 truncate sm:inline">
                  {connectionMeta.sessionUser}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">
                    {connectionMeta.sessionUser}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setIsCommandOpen(true)}>
                    <HugeiconsIcon icon={CommandIcon} />
                    <span>Command Palette</span>
                    <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handlePingHealth(true)}>
                    <HugeiconsIcon icon={RefreshIcon} />
                    <span>Ping /api/health</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={isSigningOut}
                    onClick={handleSignOut}
                  >
                    <HugeiconsIcon icon={Logout03Icon} />
                    <span>{isSigningOut ? "Signing Out…" : "Sign Out"}</span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Connection Error Banner when PostgreSQL catalog cannot be loaded */}
        {catalogError && !isBannerDismissed && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/90 px-3 py-1.5 text-xs text-amber-950"
          >
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                icon={Alert02Icon}
                size={14}
                className="shrink-0 text-amber-600"
              />
              <span className="font-medium">Database connection issue:</span>
              <span className="text-amber-900">{catalogError}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void handlePingHealth(true)}
                className="bg-white"
              >
                <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
                <span>Ping DB</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss connection notice"
                onClick={() => setIsBannerDismissed(true)}
              >
                <HugeiconsIcon icon={Cancel01Icon} />
              </Button>
            </div>
          </div>
        )}

        {/* Active Studio View */}
        <main className="flex min-h-0 flex-1 overflow-hidden">
          {activeView === "tables" && (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <AnimatePresence initial={false}>
                {isSidebarOpen && (
                  <motion.aside
                    key="tables-rail"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 224, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full shrink-0 overflow-hidden border-r border-border bg-[#fafafa]"
                  >
                    <div className="flex h-full w-56 flex-col">
                      <div className="border-b border-border p-2">
                        <InputGroup className="h-7 bg-background">
                          <InputGroupAddon>
                            <HugeiconsIcon icon={Search01Icon} />
                          </InputGroupAddon>
                          <InputGroupInput
                            value={sidebarSearch}
                            onChange={(e) => setSidebarSearch(e.target.value)}
                            placeholder="Filter..."
                            aria-label="Filter tables"
                          />
                          {sidebarSearch && (
                            <InputGroupAddon align="inline-end">
                              <InputGroupButton
                                size="icon-xs"
                                aria-label="Clear table filter"
                                onClick={() => setSidebarSearch("")}
                              >
                                <HugeiconsIcon icon={Cancel01Icon} />
                              </InputGroupButton>
                            </InputGroupAddon>
                          )}
                        </InputGroup>
                      </div>

                      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
                        {filteredCatalog.length === 0 ? (
                          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-xs text-zinc-600">
                            <HugeiconsIcon
                              icon={GridTableIcon}
                              size={16}
                              className="mb-1.5 text-zinc-500"
                            />
                            <p className="font-medium text-foreground">
                              {catalog.length === 0
                                ? "No tables found"
                                : "No matching tables"}
                            </p>
                          </div>
                        ) : (
                          filteredCatalog.map((table) => {
                            const fullName = `${table.schema}.${table.name}`;
                            const isActive =
                              activeTable?.schema === table.schema &&
                              activeTable?.name === table.name;

                            return (
                              <ContextMenu key={fullName}>
                                <ContextMenuTrigger
                                  render={
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleSelectTable(
                                          table.schema,
                                          table.name
                                        )
                                      }
                                      title={fullName}
                                      className={cn(
                                        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
                                        isActive
                                          ? "bg-zinc-200/75 font-medium text-foreground"
                                          : "text-zinc-600 hover:bg-zinc-200/45 hover:text-foreground"
                                      )}
                                    />
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={GridTableIcon}
                                    size={14}
                                    className={cn(
                                      "shrink-0",
                                      isActive
                                        ? "text-foreground"
                                        : "text-zinc-500 group-hover:text-foreground"
                                    )}
                                  />
                                  <span className="min-w-0 flex-1 truncate">
                                    {table.schema === "public"
                                      ? table.name
                                      : fullName}
                                  </span>
                                  <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
                                    {table.rowEstimate.toLocaleString()}
                                  </span>
                                </ContextMenuTrigger>

                                <ContextMenuContent className="w-52">
                                  <ContextMenuGroup>
                                    <ContextMenuLabel className="truncate">
                                      {fullName}
                                    </ContextMenuLabel>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem
                                      onClick={() =>
                                        handleSelectTable(
                                          table.schema,
                                          table.name
                                        )
                                      }
                                    >
                                      <HugeiconsIcon icon={Table01Icon} />
                                      <span>Open table</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      onClick={() => {
                                        setSqlConsoleDraft(
                                          buildQualifiedSelectSql(
                                            table.schema,
                                            table.name
                                          )
                                        );
                                        setActiveView("sql");
                                      }}
                                    >
                                      <HugeiconsIcon icon={SqlIcon} />
                                      <span>Query in SQL</span>
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      onClick={() =>
                                        void handleCopyText(
                                          buildQualifiedSelectSql(
                                            table.schema,
                                            table.name
                                          ),
                                          `${fullName} SELECT`
                                        )
                                      }
                                    >
                                      <HugeiconsIcon icon={Copy01Icon} />
                                      <span>Copy SELECT SQL</span>
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem
                                      onClick={() =>
                                        setSchemaInspector({
                                          title: `Schema: ${fullName}`,
                                          subtitle: `${table.columns.length} columns · ${table.rowEstimate.toLocaleString()} rows`,
                                          payload: {
                                            schema: table.schema,
                                            table: table.name,
                                            rowEstimate: table.rowEstimate,
                                            primaryKeyColumns:
                                              table.primaryKeyColumns,
                                            columns: table.columns,
                                          },
                                        })
                                      }
                                    >
                                      <HugeiconsIcon icon={BracesIcon} />
                                      <span>Inspect schema</span>
                                    </ContextMenuItem>
                                  </ContextMenuGroup>
                                </ContextMenuContent>
                              </ContextMenu>
                            );
                          })
                        )}
                      </div>

                      <div className="flex h-9 shrink-0 items-center justify-between border-t border-border px-3 text-[11px] text-zinc-600 tabular-nums">
                        <span>
                          {catalog.length}{" "}
                          {catalog.length === 1 ? "table" : "tables"}
                        </span>
                        <span>{totalCatalogRows.toLocaleString()} rows</span>
                      </div>
                    </div>
                  </motion.aside>
                )}
              </AnimatePresence>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                <DataGridView
                  activeTable={activeTable}
                  result={tableResult}
                  isLoading={isBrowsing}
                  onRefresh={handleRefreshTable}
                  onResultUpdated={handleResultUpdated}
                  onOpenSqlTab={handleOpenSqlTab}
                  serverPagination={serverPagination}
                />
              </div>
            </div>
          )}

          {activeView === "sql" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SqlConsoleView
                schemaCatalog={catalog}
                initialSql={sqlConsoleDraft}
                onJumpToTable={(schema, name) =>
                  handleSelectTable(schema, name)
                }
              />
            </div>
          )}

          {activeView === "visualizer" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <SchemaVisualizerView
                onOpenTable={(schema, name) => handleSelectTable(schema, name)}
              />
            </div>
          )}

          {activeView === "backup" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <BackupRestoreView
                schemaCatalog={catalog}
                onRestored={() => {
                  router.refresh();
                  if (browseParams.schema && browseParams.table) {
                    fetchTablePage(browseParams);
                  }
                }}
              />
            </div>
          )}

          {activeView === "activity" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ActivityStatsView
                onOpenTable={(schema, name) => handleSelectTable(schema, name)}
              />
            </div>
          )}
        </main>

        {/* ⌘K Command Palette */}
        <CommandDialog
          open={isCommandOpen}
          onOpenChange={setIsCommandOpen}
          title="Quick Jump"
          description="Jump to a table, switch studio view, or run a studio action."
        >
          <Command>
            <CommandInput placeholder="Jump to table, view, or command..." />
            <CommandList>
              <CommandEmpty>No matching commands or tables.</CommandEmpty>

              <CommandGroup heading="Studio Views">
                <CommandItem
                  value="view tables"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    setActiveView("tables");
                  }}
                >
                  <HugeiconsIcon icon={Table01Icon} />
                  <span>Tables</span>
                  <CommandShortcut>Grid</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="view sql console"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    setActiveView("sql");
                  }}
                >
                  <HugeiconsIcon icon={SqlIcon} />
                  <span>SQL Console</span>
                  <CommandShortcut>Query</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="view schema visualizer"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    setActiveView("visualizer");
                  }}
                >
                  <HugeiconsIcon icon={HierarchyIcon} />
                  <span>Schema Visualizer</span>
                  <CommandShortcut>ER</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="view backup restore"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    setActiveView("backup");
                  }}
                >
                  <HugeiconsIcon icon={DatabaseExportIcon} />
                  <span>Backup &amp; Restore</span>
                  <CommandShortcut>Dump</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="view activity stats"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    setActiveView("activity");
                  }}
                >
                  <HugeiconsIcon icon={Activity01Icon} />
                  <span>Activity &amp; Stats</span>
                  <CommandShortcut>Live</CommandShortcut>
                </CommandItem>
              </CommandGroup>

              {catalog.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Tables">
                    {catalog.map((table) => {
                      const fullName = `${table.schema}.${table.name}`;
                      return (
                        <CommandItem
                          key={fullName}
                          value={`table ${fullName}`}
                          onSelect={() => {
                            setIsCommandOpen(false);
                            handleSelectTable(table.schema, table.name);
                          }}
                        >
                          <HugeiconsIcon icon={GridTableIcon} />
                          <span className="truncate">
                            {table.schema === "public" ? table.name : fullName}
                          </span>
                          <CommandShortcut className="tabular-nums">
                            {table.rowEstimate.toLocaleString()}
                          </CommandShortcut>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}

              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem
                  value="action ping health"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    void handlePingHealth(true);
                  }}
                >
                  <HugeiconsIcon icon={RefreshIcon} />
                  <span>Check /api/health</span>
                </CommandItem>
                {activeTable && (
                  <CommandItem
                    value="action refresh active table"
                    onSelect={() => {
                      setIsCommandOpen(false);
                      handleRefreshTable();
                    }}
                  >
                    <HugeiconsIcon icon={RefreshIcon} />
                    <span>
                      Refresh {activeTable.schema}.{activeTable.name}
                    </span>
                  </CommandItem>
                )}
                <CommandItem
                  value="action sign out"
                  onSelect={() => {
                    setIsCommandOpen(false);
                    handleSignOut();
                  }}
                >
                  <HugeiconsIcon icon={Logout03Icon} />
                  <span>Sign Out</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </CommandDialog>

        {/* Table Schema Inspector Dialog */}
        <Dialog
          open={schemaInspector !== null}
          onOpenChange={(open) => {
            if (!open) setSchemaInspector(null);
          }}
        >
          <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {schemaInspector?.title ?? "Table Schema"}
              </DialogTitle>
              <DialogDescription>
                {schemaInspector?.subtitle}
              </DialogDescription>
            </DialogHeader>

            <JsonbViewer
              value={schemaInspector?.payload ?? null}
              readOnly
              className="h-80 w-full"
            />

            <DialogFooter showCloseButton>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void handleCopyText(
                    formatJsonb(schemaInspector?.payload ?? null),
                    "table schema JSON"
                  )
                }
              >
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                <span>Copy JSON</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </MotionConfig>
  );
}

export default PgsaWorkbench;
