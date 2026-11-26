"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Database02Icon,
  Loading03Icon,
  Plug01Icon,
  RefreshIcon,
  Search01Icon,
  ShieldCheckIcon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import {
  getActivityStatsAction,
  signalBackendPidAction,
} from "@/app/actions";
import { SqlEditor } from "@/components/sql-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  ActivityAndStatsPayload,
  ActivityProcess,
} from "@/types/postgres";

export interface ActivityStatsViewProps {
  focusedTableKey?: string | null;
  onOpenTable?: (schema: string, table: string) => void;
}

type StatsSubTab = "connections" | "storage" | "roles";

interface PendingSignal {
  process: ActivityProcess;
  mode: "cancel" | "terminate";
}

const NOOP = () => {};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function getStateDotClass(state: string | null): string {
  if (state === "active") return "bg-emerald-500";
  if (state === "idle") return "bg-zinc-400";
  if (state?.startsWith("idle in transaction")) return "bg-amber-500";
  if (state === "fastpath function call" || state === "disabled") {
    return "bg-zinc-500";
  }
  return "bg-zinc-300";
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Live PostgreSQL server telemetry view exposing `pg_stat_activity`,
 * `pg_stat_user_tables` storage/index breakdowns, and `pg_roles`/`pg_extension`.
 */
export function ActivityStatsView({
  focusedTableKey = null,
  onOpenTable,
}: ActivityStatsViewProps) {
  const [activeTab, setActiveTab] = useState<StatsSubTab>("connections");
  const [payload, setPayload] = useState<ActivityAndStatsPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [prevFocusedTableKey, setPrevFocusedTableKey] = useState<string | null>(
    focusedTableKey
  );
  if (focusedTableKey !== prevFocusedTableKey) {
    setPrevFocusedTableKey(focusedTableKey);
    if (focusedTableKey) {
      setActiveTab("storage");
      setFilterText(focusedTableKey.split(".").pop() ?? focusedTableKey);
    }
  }

  // Modal state
  const [inspectedProcess, setInspectedProcess] =
    useState<ActivityProcess | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);
  const [pendingSignal, setPendingSignal] = useState<PendingSignal | null>(
    null
  );
  const [isSignalling, startSignalTransition] = useTransition();

  const requestSeqRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  const applyStatsResponse = useCallback(
    (data: ActivityAndStatsPayload, mode: "initial" | "refresh") => {
      if (!data.ok) {
        setLoadError(data.error ?? "Failed to load PostgreSQL telemetry.");
        if (mode === "refresh") {
          toast.error("Failed to refresh telemetry", {
            description: data.error,
          });
        }
        return;
      }

      setPayload(data);
      setLoadError(null);
      setLastUpdatedLabel(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    },
    []
  );

  const loadStats = useCallback(
    async (mode: "initial" | "refresh") => {
      const reqId = ++requestSeqRef.current;
      if (mode === "initial") {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      try {
        const data = await getActivityStatsAction();
        if (reqId !== requestSeqRef.current) return;
        applyStatsResponse(data, mode);
      } catch (error) {
        if (reqId !== requestSeqRef.current) return;
        const message =
          error instanceof Error ? error.message : "Failed to load telemetry.";
        setLoadError(message);
        if (mode === "refresh") {
          toast.error("Failed to refresh telemetry", { description: message });
        }
      } finally {
        if (reqId === requestSeqRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [applyStatsResponse]
  );

  useEffect(() => {
    let active = true;
    const reqId = ++requestSeqRef.current;

    void getActivityStatsAction()
      .then((data) => {
        if (!active || reqId !== requestSeqRef.current) return;
        applyStatsResponse(data, "initial");
      })
      .catch((error: unknown) => {
        if (!active || reqId !== requestSeqRef.current) return;
        const message =
          error instanceof Error ? error.message : "Failed to load telemetry.";
        setLoadError(message);
      })
      .finally(() => {
        if (active && reqId === requestSeqRef.current) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, [applyStatsResponse]);

  const backendSummary = useMemo(() => {
    const list = payload?.activities ?? [];
    let active = 0;
    let idle = 0;
    for (const item of list) {
      if (item.state === "active") active += 1;
      else if (item.state === "idle") idle += 1;
    }
    return { active, idle, total: list.length };
  }, [payload]);

  const needle = filterText.trim().toLowerCase();

  const filteredActivities = useMemo(() => {
    const items = payload?.activities ?? [];
    if (!needle) return items;
    return items.filter((item) => {
      return (
        String(item.pid).includes(needle) ||
        (item.usename ?? "").toLowerCase().includes(needle) ||
        item.applicationName.toLowerCase().includes(needle) ||
        (item.state ?? "").toLowerCase().includes(needle) ||
        item.query.toLowerCase().includes(needle)
      );
    });
  }, [needle, payload]);

  const sortedTableStats = useMemo(() => {
    const items = [...(payload?.tableStats ?? [])].sort((a, b) => {
      if (b.totalBytes !== a.totalBytes) return b.totalBytes - a.totalBytes;
      if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
      return a.name.localeCompare(b.name);
    });
    if (!needle) return items;
    return items.filter((item) =>
      `${item.schema}.${item.name}`.toLowerCase().includes(needle)
    );
  }, [needle, payload]);

  const maxTableBytes = useMemo(() => {
    let max = 0;
    for (const stat of payload?.tableStats ?? []) {
      if (stat.totalBytes > max) max = stat.totalBytes;
    }
    return max;
  }, [payload]);

  const filteredRoles = useMemo(() => {
    const roles = payload?.roles ?? [];
    if (!needle) return roles;
    return roles.filter((r) => r.rolname.toLowerCase().includes(needle));
  }, [needle, payload]);

  const filteredExtensions = useMemo(() => {
    const extensions = payload?.extensions ?? [];
    if (!needle) return extensions;
    return extensions.filter(
      (ext) =>
        ext.name.toLowerCase().includes(needle) ||
        ext.schema.toLowerCase().includes(needle)
    );
  }, [needle, payload]);

  const handleConfirmSignal = useCallback(() => {
    if (!pendingSignal || isSignalling) return;
    const { process, mode } = pendingSignal;

    startSignalTransition(async () => {
      try {
        const res = await signalBackendPidAction({ pid: process.pid, mode });
        setPendingSignal(null);

        if (!res.ok) {
          toast.error(
            mode === "cancel"
              ? `Could not cancel PID ${process.pid}`
              : `Could not terminate PID ${process.pid}`,
            { description: res.error }
          );
          return;
        }

        toast.success(
          mode === "cancel"
            ? `Sent cancel signal to PID ${process.pid}`
            : `Terminated backend PID ${process.pid}`
        );
        void loadStats("refresh");
      } catch (error) {
        setPendingSignal(null);
        toast.error("Signal failed", {
          description:
            error instanceof Error ? error.message : "Unknown backend error.",
        });
      }
    });
  }, [isSignalling, loadStats, pendingSignal]);

  const handleCopySql = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedSql(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedSql(false);
      }, 1800);
      toast.success("Copied SQL to clipboard");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-zinc-900">
      {/* Flush Metric Strip */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-zinc-50/70 px-4 text-xs">
        <div className="flex min-w-0 items-center gap-5 overflow-x-auto whitespace-nowrap">
          <div className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Database02Icon}
              strokeWidth={1.8}
              className="size-3.5 shrink-0 text-zinc-600"
            />
            <span className="text-zinc-600">Database</span>
            <span className="font-mono font-medium text-zinc-900">
              {payload?.databaseName || "—"}
            </span>
          </div>

          <Separator orientation="vertical" className="h-4" />

          <div className="flex items-center gap-2 tabular-nums">
            <span className="text-zinc-600">Total Size</span>
            <span className="font-mono font-medium text-zinc-900">
              {payload ? formatBytes(payload.databaseSizeBytes) : "—"}
            </span>
          </div>

          <Separator orientation="vertical" className="h-4" />

          <div className="flex items-center gap-2 tabular-nums">
            <span className="text-zinc-600">Backends</span>
            <span className="font-medium text-zinc-900">
              {payload
                ? `${backendSummary.active} active / ${backendSummary.idle} idle`
                : "—"}
            </span>
          </div>

          <Separator orientation="vertical" className="h-4" />

          <div className="flex items-center gap-2 tabular-nums">
            <span className="text-zinc-600">Tables</span>
            <span className="font-medium text-zinc-900">
              {payload ? payload.tableStats.length.toLocaleString() : "—"}
            </span>
          </div>

          <Separator orientation="vertical" className="h-4" />

          <div className="flex items-center gap-2 tabular-nums">
            <span className="text-zinc-600">Roles</span>
            <span className="font-medium text-zinc-900">
              {payload ? payload.roles.length.toLocaleString() : "—"}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {lastUpdatedLabel && (
            <span className="hidden font-mono text-[11px] text-zinc-600 tabular-nums sm:inline">
              {lastUpdatedLabel}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isLoading || isRefreshing}
            onClick={() => void loadStats("refresh")}
          >
            <HugeiconsIcon
              icon={isRefreshing ? Loading03Icon : RefreshIcon}
              strokeWidth={2}
              className={cn(isRefreshing && "animate-spin")}
              data-icon="inline-start"
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Sub-tabs & Workspace */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (
            value === "connections" ||
            value === "storage" ||
            value === "roles"
          ) {
            setActiveTab(value);
          }
        }}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4">
          <TabsList variant="line" className="gap-4">
            <TabsTrigger
              value="connections"
              className="px-1 text-xs font-medium"
            >
              <span>Connections</span>
              {payload && (
                <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                  {payload.activities.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="storage" className="px-1 text-xs font-medium">
              <span>Storage &amp; Indexes</span>
              {payload && (
                <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                  {payload.tableStats.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="roles" className="px-1 text-xs font-medium">
              <span>Roles &amp; Extensions</span>
            </TabsTrigger>
          </TabsList>

          <div className="relative w-56 max-w-[45%]">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.8}
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500"
            />
            <Input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="Filter current view..."
              aria-label="Filter current telemetry view"
              className="h-7 border-zinc-200 bg-zinc-50/60 pl-8 text-xs placeholder:text-zinc-500 focus-visible:bg-white"
            />
          </div>
        </div>

        {loadError && !payload ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <div className="flex size-9 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600">
              <HugeiconsIcon
                icon={AlertCircleIcon}
                strokeWidth={1.8}
                className="size-4"
              />
            </div>
            <div className="flex max-w-md flex-col gap-1">
              <p className="text-sm font-medium text-zinc-900">
                Unable to load database activity
              </p>
              <p className="text-xs text-zinc-500">{loadError}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadStats("initial")}
            >
              Retry
            </Button>
          </div>
        ) : isLoading && !payload ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-zinc-600">
            <HugeiconsIcon
              icon={Loading03Icon}
              strokeWidth={2}
              className="size-4 animate-spin text-zinc-500"
            />
            <span>Loading PostgreSQL telemetry...</span>
          </div>
        ) : (
          <>
            {/* Connections Tab */}
            <TabsContent value="connections" className="min-h-0 flex-1">
              <div className="h-full overflow-auto">
                {loadError && (
                  <div className="border-b border-red-200 bg-red-50/60 px-4 py-2 text-xs text-red-700">
                    Refresh warning: {loadError}
                  </div>
                )}
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur-xs">
                    <tr className="text-[11px] font-medium text-zinc-600">
                      <th className="h-8 px-4 font-medium whitespace-nowrap">
                        PID
                      </th>
                      <th className="h-8 px-3 font-medium whitespace-nowrap">
                        User
                      </th>
                      <th className="h-8 px-3 font-medium whitespace-nowrap">
                        App
                      </th>
                      <th className="h-8 px-3 font-medium whitespace-nowrap">
                        State
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Duration
                      </th>
                      <th className="h-8 w-full px-3 font-medium">SQL</th>
                      <th className="h-8 px-4 text-right font-medium whitespace-nowrap">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {filteredActivities.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-10 text-center text-xs text-zinc-500"
                        >
                          No matching backend processes.
                        </td>
                      </tr>
                    ) : (
                      filteredActivities.map((proc) => {
                        const waitLabel = proc.waitEventType
                          ? `${proc.waitEventType}${proc.waitEvent ? `:${proc.waitEvent}` : ""}`
                          : null;

                        return (
                          <tr
                            key={proc.pid}
                            className="transition-colors hover:bg-zinc-50/80"
                          >
                            <td className="px-4 py-2 font-mono whitespace-nowrap tabular-nums">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-zinc-900">
                                  {proc.pid}
                                </span>
                                {proc.isCurrentBackend && (
                                  <span className="rounded border border-zinc-200 bg-zinc-100 px-1.5 py-px font-sans text-[11px] font-medium text-zinc-700">
                                    Current
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-zinc-700">
                              <div className="flex flex-col">
                                <span>{proc.usename ?? "—"}</span>
                                {proc.clientAddr && (
                                  <span className="font-mono text-[11px] text-zinc-500">
                                    {proc.clientAddr}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="max-w-44 truncate px-3 py-2 text-zinc-600">
                              {proc.applicationName || "—"}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "size-1.5 shrink-0 rounded-full",
                                    getStateDotClass(proc.state)
                                  )}
                                />
                                <span className="text-zinc-800">
                                  {proc.state ?? "unknown"}
                                </span>
                                {waitLabel && (
                                  <span className="font-mono text-[11px] text-zinc-500">
                                    ({waitLabel})
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-700 tabular-nums">
                              {formatDuration(proc.durationMs)}
                            </td>
                            <td className="max-w-xs px-3 py-2">
                              {proc.query ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCopiedSql(false);
                                    setInspectedProcess(proc);
                                  }}
                                  className="block w-full truncate text-left font-mono text-[11px] text-zinc-700 underline-offset-2 hover:text-zinc-950 hover:underline"
                                >
                                  {proc.query.replace(/\s+/g, " ").trim()}
                                </button>
                              ) : (
                                <span className="font-mono text-[11px] text-zinc-500">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                {proc.isCurrentBackend ? (
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span className="inline-flex" />
                                        }
                                      >
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="xs"
                                          disabled
                                        >
                                          <HugeiconsIcon
                                            icon={Cancel01Icon}
                                            strokeWidth={2}
                                            data-icon="inline-start"
                                          />
                                          Cancel
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent side="left">
                                        Current PGSA backend cannot be
                                        cancelled
                                      </TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span className="inline-flex" />
                                        }
                                      >
                                        <Button
                                          type="button"
                                          variant="destructive"
                                          size="xs"
                                          disabled
                                        >
                                          <HugeiconsIcon
                                            icon={StopIcon}
                                            strokeWidth={2}
                                            data-icon="inline-start"
                                          />
                                          Terminate
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent side="left">
                                        Current PGSA backend cannot be
                                        terminated
                                      </TooltipContent>
                                    </Tooltip>
                                  </>
                                ) : (
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="xs"
                                            disabled={isSignalling}
                                            onClick={() =>
                                              setPendingSignal({
                                                process: proc,
                                                mode: "cancel",
                                              })
                                            }
                                          />
                                        }
                                      >
                                        <HugeiconsIcon
                                          icon={Cancel01Icon}
                                          strokeWidth={2}
                                          data-icon="inline-start"
                                        />
                                        Cancel
                                      </TooltipTrigger>
                                      <TooltipContent side="top">
                                        Cancel running query (pg_cancel_backend)
                                      </TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            type="button"
                                            variant="destructive"
                                            size="xs"
                                            disabled={isSignalling}
                                            onClick={() =>
                                              setPendingSignal({
                                                process: proc,
                                                mode: "terminate",
                                              })
                                            }
                                          />
                                        }
                                      >
                                        <HugeiconsIcon
                                          icon={StopIcon}
                                          strokeWidth={2}
                                          data-icon="inline-start"
                                        />
                                        Terminate
                                      </TooltipTrigger>
                                      <TooltipContent side="top">
                                        Terminate session (pg_terminate_backend)
                                      </TooltipContent>
                                    </Tooltip>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            {/* Storage & Indexes Tab */}
            <TabsContent value="storage" className="min-h-0 flex-1">
              <div className="h-full overflow-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur-xs">
                    <tr className="text-[11px] font-medium text-zinc-600">
                      <th className="h-8 px-4 font-medium whitespace-nowrap">
                        Table
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Rows
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Table Size
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Index Size
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Total
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Seq Scans
                      </th>
                      <th className="h-8 px-3 text-right font-medium whitespace-nowrap">
                        Idx Scans
                      </th>
                      <th className="h-8 px-4 text-right font-medium whitespace-nowrap">
                        Dead Tuples
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {sortedTableStats.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-4 py-10 text-center text-xs text-zinc-500"
                        >
                          No user table statistics available.
                        </td>
                      </tr>
                    ) : (
                      sortedTableStats.map((row) => {
                        const relPct =
                          maxTableBytes > 0
                            ? Math.max(
                                row.totalBytes > 0 ? 2 : 0,
                                (row.totalBytes / maxTableBytes) * 100
                              )
                            : 0;
                        const tableSharePct =
                          row.totalBytes > 0
                            ? (row.tableBytes / row.totalBytes) * 100
                            : 100;
                        const indexSharePct = Math.max(
                          0,
                          100 - tableSharePct
                        );

                        return (
                          <tr
                            key={`${row.schema}.${row.name}`}
                            className="transition-colors hover:bg-zinc-50/80"
                          >
                            <td className="px-4 py-2 whitespace-nowrap">
                              {onOpenTable ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenTable(row.schema, row.name)
                                  }
                                  className="group inline-flex items-center gap-1.5 font-mono text-left text-zinc-900 hover:underline underline-offset-2"
                                >
                                  <span>
                                    <span className="text-zinc-500">
                                      {row.schema}.
                                    </span>
                                    <span className="font-medium">
                                      {row.name}
                                    </span>
                                  </span>
                                  <HugeiconsIcon
                                    icon={ArrowUpRight01Icon}
                                    strokeWidth={2}
                                    className="size-3 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100"
                                  />
                                </button>
                              ) : (
                                <span className="font-mono">
                                  <span className="text-zinc-500">
                                    {row.schema}.
                                  </span>
                                  <span className="font-medium text-zinc-900">
                                    {row.name}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-700 tabular-nums">
                              {row.rowEstimate.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-700 tabular-nums">
                              {formatBytes(row.tableBytes)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-500 tabular-nums">
                              {formatBytes(row.indexBytes)}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <div className="inline-flex items-center justify-end gap-2.5">
                                <div
                                  className="h-1 w-20 overflow-hidden rounded-full bg-zinc-100"
                                  title={`Table: ${formatBytes(row.tableBytes)} · Indexes: ${formatBytes(row.indexBytes)}`}
                                >
                                  <div
                                    className="flex h-full overflow-hidden rounded-full"
                                    style={{ width: `${relPct}%` }}
                                  >
                                    <div
                                      className="h-full bg-zinc-900"
                                      style={{ width: `${tableSharePct}%` }}
                                    />
                                    <div
                                      className="h-full bg-zinc-400"
                                      style={{ width: `${indexSharePct}%` }}
                                    />
                                  </div>
                                </div>
                                <span className="w-16 text-right font-mono font-medium text-zinc-900 tabular-nums">
                                  {formatBytes(row.totalBytes)}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-700 tabular-nums">
                              {row.seqScan.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-zinc-700 tabular-nums">
                              {row.idxScan.toLocaleString()}
                            </td>
                            <td
                              className={cn(
                                "px-4 py-2 text-right font-mono whitespace-nowrap tabular-nums",
                                row.nDeadTup > 1000
                                  ? "font-medium text-amber-700"
                                  : "text-zinc-600"
                              )}
                            >
                              {row.nDeadTup.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            {/* Roles & Extensions Tab */}
            <TabsContent value="roles" className="min-h-0 flex-1">
              <div className="grid h-full min-h-0 grid-cols-1 xl:grid-cols-[1.4fr_1fr]">
                {/* Roles Table */}
                <div className="flex min-h-0 flex-col border-b border-zinc-200 xl:border-r xl:border-b-0">
                  <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50/70 px-4 text-xs">
                    <span className="flex items-center gap-2 font-medium text-zinc-800">
                      <HugeiconsIcon
                        icon={ShieldCheckIcon}
                        strokeWidth={1.8}
                        className="size-3.5 text-zinc-500"
                      />
                      Roles
                    </span>
                    <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                      {filteredRoles.length}
                    </span>
                  </div>

                  <div className="min-h-0 flex-1 overflow-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur-xs">
                        <tr className="text-[11px] font-medium text-zinc-500">
                          <th className="h-8 px-4 font-medium whitespace-nowrap">
                            Role
                          </th>
                          <th className="h-8 px-3 text-center font-medium whitespace-nowrap">
                            Login
                          </th>
                          <th className="h-8 px-3 text-center font-medium whitespace-nowrap">
                            Superuser
                          </th>
                          <th className="h-8 px-3 text-center font-medium whitespace-nowrap">
                            Create DB
                          </th>
                          <th className="h-8 px-3 text-center font-medium whitespace-nowrap">
                            Create Role
                          </th>
                          <th className="h-8 px-4 text-right font-medium whitespace-nowrap">
                            Conn Limit
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {filteredRoles.length === 0 ? (
                          <tr>
                            <td
                              colSpan={6}
                              className="px-4 py-10 text-center text-xs text-zinc-500"
                            >
                              No matching roles.
                            </td>
                          </tr>
                        ) : (
                          filteredRoles.map((role) => (
                            <tr
                              key={role.rolname}
                              className="transition-colors hover:bg-zinc-50/80"
                            >
                              <td className="px-4 py-2 font-mono whitespace-nowrap">
                                <span
                                  className={cn(
                                    role.rolname.startsWith("pg_")
                                      ? "text-zinc-500"
                                      : "font-medium text-zinc-900"
                                  )}
                                >
                                  {role.rolname}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <RoleCapabilityCell enabled={role.rolcanlogin} />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <RoleCapabilityCell enabled={role.rolsuper} />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <RoleCapabilityCell
                                  enabled={role.rolcreatedb}
                                />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <RoleCapabilityCell
                                  enabled={role.rolcreaterole}
                                />
                              </td>
                              <td className="px-4 py-2 text-right font-mono whitespace-nowrap text-zinc-600 tabular-nums">
                                {role.rolconnlimit < 0
                                  ? "Unlimited"
                                  : role.rolconnlimit.toLocaleString()}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Extensions Table */}
                <div className="flex min-h-0 flex-col">
                  <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50/70 px-4 text-xs">
                    <span className="flex items-center gap-2 font-medium text-zinc-800">
                      <HugeiconsIcon
                        icon={Plug01Icon}
                        strokeWidth={1.8}
                        className="size-3.5 text-zinc-500"
                      />
                      Extensions
                    </span>
                    <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
                      {filteredExtensions.length}
                    </span>
                  </div>

                  <div className="min-h-0 flex-1 overflow-auto">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur-xs">
                        <tr className="text-[11px] font-medium text-zinc-500">
                          <th className="h-8 px-4 font-medium whitespace-nowrap">
                            Extension
                          </th>
                          <th className="h-8 px-3 font-medium whitespace-nowrap">
                            Version
                          </th>
                          <th className="h-8 px-4 font-medium whitespace-nowrap">
                            Schema
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {filteredExtensions.length === 0 ? (
                          <tr>
                            <td
                              colSpan={3}
                              className="px-4 py-10 text-center text-xs text-zinc-500"
                            >
                              No installed extensions match the filter.
                            </td>
                          </tr>
                        ) : (
                          filteredExtensions.map((ext) => (
                            <tr
                              key={`${ext.schema}.${ext.name}`}
                              className="transition-colors hover:bg-zinc-50/80"
                            >
                              <td className="px-4 py-2 font-mono font-medium whitespace-nowrap text-zinc-900">
                                {ext.name}
                              </td>
                              <td className="px-3 py-2 font-mono whitespace-nowrap text-zinc-600 tabular-nums">
                                {ext.version}
                              </td>
                              <td className="px-4 py-2 font-mono whitespace-nowrap text-zinc-500">
                                {ext.schema}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>

      {/* Full SQL Dialog */}
      <Dialog
        open={inspectedProcess !== null}
        onOpenChange={(open) => {
          if (!open) setInspectedProcess(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              Backend PID {inspectedProcess?.pid}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {inspectedProcess?.usename ?? "unknown user"} ·{" "}
              {inspectedProcess?.applicationName || "no application name"} ·{" "}
              {inspectedProcess?.state ?? "unknown state"}
            </DialogDescription>
          </DialogHeader>

          {inspectedProcess && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2 text-xs sm:grid-cols-3">
                <div>
                  <span className="text-zinc-500">Duration: </span>
                  <span className="font-mono font-medium text-zinc-900 tabular-nums">
                    {formatDuration(inspectedProcess.durationMs)}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Client: </span>
                  <span className="font-mono text-zinc-900">
                    {inspectedProcess.clientAddr ?? "local"}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500">Wait: </span>
                  <span className="font-mono text-zinc-900">
                    {inspectedProcess.waitEventType
                      ? `${inspectedProcess.waitEventType}:${inspectedProcess.waitEvent ?? ""}`
                      : "None"}
                  </span>
                </div>
                <div className="col-span-2 sm:col-span-3">
                  <span className="text-zinc-500">Query started: </span>
                  <span className="font-mono text-zinc-800">
                    {formatTimestamp(inspectedProcess.queryStart)}
                  </span>
                </div>
              </div>

              <div className="h-64 overflow-hidden rounded-md border border-zinc-200">
                <SqlEditor
                  value={inspectedProcess.query}
                  onChange={NOOP}
                  readOnly
                  className="h-full rounded-none border-0 focus-within:ring-0"
                />
              </div>
            </div>
          )}

          <DialogFooter showCloseButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!inspectedProcess?.query}
              onClick={() => {
                if (inspectedProcess?.query) {
                  void handleCopySql(inspectedProcess.query);
                }
              }}
            >
              <HugeiconsIcon
                icon={copiedSql ? Tick02Icon : Copy01Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              {copiedSql ? "Copied" : "Copy SQL"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel / Terminate Backend Confirmation */}
      <AlertDialog
        open={pendingSignal !== null}
        onOpenChange={(open) => {
          if (!open && !isSignalling) {
            setPendingSignal(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingSignal?.mode === "cancel"
                ? `Cancel query on PID ${pendingSignal.process.pid}?`
                : `Terminate backend PID ${pendingSignal?.process.pid}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSignal?.mode === "cancel"
                ? "Sends pg_cancel_backend() to interrupt the active query while keeping the client connection open."
                : "Sends pg_terminate_backend() to forcefully close the backend session and abort any uncommitted work."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pendingSignal && (
            <div className="flex flex-col gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-600">
                <span>
                  User:{" "}
                  <strong className="font-medium text-zinc-900">
                    {pendingSignal.process.usename ?? "—"}
                  </strong>
                </span>
                <span>
                  State:{" "}
                  <strong className="font-medium text-zinc-900">
                    {pendingSignal.process.state ?? "—"}
                  </strong>
                </span>
              </div>
              {pendingSignal.process.query && (
                <pre className="max-h-24 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap text-zinc-800">
                  {pendingSignal.process.query}
                </pre>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSignalling}>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant={
                pendingSignal?.mode === "terminate" ? "destructive" : "default"
              }
              disabled={isSignalling}
              onClick={handleConfirmSignal}
            >
              {isSignalling
                ? "Sending..."
                : pendingSignal?.mode === "cancel"
                  ? "Cancel Query"
                  : "Terminate Backend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoleCapabilityCell({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return (
      <span className="text-zinc-500" aria-label="No">
        —
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center text-zinc-900"
      aria-label="Yes"
    >
      <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.2} className="size-3.5" />
    </span>
  );
}

export default ActivityStatsView;
