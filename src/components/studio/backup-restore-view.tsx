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
  Alert02Icon,
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  DatabaseExportIcon,
  DatabaseRestoreIcon,
  Download01Icon,
  EyeIcon,
  FileCodeIcon,
  Loading03Icon,
  Search01Icon,
  Tick02Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { generateBackupAction, restoreSqlAction } from "@/app/actions";
import { JsonbViewer } from "@/components/jsonb-viewer";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  BackupOptions,
  BackupResult,
  RestoreResult,
  TableSchema,
} from "@/types/postgres";

export interface BackupRestoreViewProps {
  schemaCatalog: TableSchema[];
  focusedTableKey?: string | null;
  onRestored?: () => void;
}

type StudioMode = "backup" | "restore";
type BackupFormat = BackupOptions["format"];

interface FormatItem {
  value: BackupFormat;
  label: string;
}

const BACKUP_FORMAT_ITEMS: FormatItem[] = [
  { value: "sql", label: "SQL Dump (.sql)" },
  { value: "json", label: "JSON Snapshot (.json)" },
];

const MAX_RESTORE_SQL_LENGTH = 10_000_000;
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

function getTableKey(table: Pick<TableSchema, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}

function quoteQualifiedTable(schema: string, name: string): string {
  const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
  return `${quote(schema)}.${quote(name)}`;
}

function parseFilenameFromDisposition(
  headerValue: string | null,
  fallback: string
): string {
  if (!headerValue) return fallback;
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  if (bareMatch?.[1]) return bareMatch[1].trim();
  return fallback;
}

/**
 * Architectural backup & restore studio view supporting logical SQL/JSON dumps,
 * live preview, `/api/backup` streaming downloads, and transactional SQL restores.
 */
export function BackupRestoreView({
  schemaCatalog,
  focusedTableKey = null,
  onRestored,
}: BackupRestoreViewProps) {
  const [activeTab, setActiveTab] = useState<StudioMode>("backup");

  // Backup configuration state
  const [format, setFormat] = useState<BackupFormat>("sql");
  const [includeSchema, setIncludeSchema] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [tableSearch, setTableSearch] = useState("");
  const [prevFocusedTableKey, setPrevFocusedTableKey] = useState<string | null>(
    focusedTableKey
  );
  if (focusedTableKey !== prevFocusedTableKey) {
    setPrevFocusedTableKey(focusedTableKey);
    if (focusedTableKey) {
      setActiveTab("backup");
      setTableSearch(focusedTableKey.split(".").pop() ?? focusedTableKey);
    }
  }
  const [deselectedTableKeys, setDeselectedTableKeys] = useState<Set<string>>(
    () => new Set()
  );

  // Preview & download state
  const [previewResult, setPreviewResult] = useState<BackupResult | null>(null);
  const [previewFormat, setPreviewFormat] = useState<BackupFormat>("sql");
  const [previewOptionsSignature, setPreviewOptionsSignature] = useState<
    string | null
  >(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [copiedPreview, setCopiedPreview] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isPreviewing, startPreviewTransition] = useTransition();
  const copyTimerRef = useRef<number | null>(null);

  // Restore state
  const [restoreSql, setRestoreSql] = useState("");
  const [singleTransaction, setSingleTransaction] = useState(true);
  const [loadedFileMeta, setLoadedFileMeta] = useState<{
    name: string;
    sizeBytes: number;
  } | null>(null);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(
    null
  );
  const [isRestoring, startRestoreTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const filteredTables = useMemo(() => {
    const needle = tableSearch.trim().toLowerCase();
    if (!needle) return schemaCatalog;
    return schemaCatalog.filter((table) => {
      const qualified = getTableKey(table).toLowerCase();
      return (
        qualified.includes(needle) || table.name.toLowerCase().includes(needle)
      );
    });
  }, [schemaCatalog, tableSearch]);

  const selectedTablesList = useMemo(() => {
    return schemaCatalog
      .filter((table) => !deselectedTableKeys.has(getTableKey(table)))
      .map((table) => quoteQualifiedTable(table.schema, table.name));
  }, [deselectedTableKeys, schemaCatalog]);

  const filteredSelectedCount = useMemo(() => {
    let count = 0;
    for (const table of filteredTables) {
      if (!deselectedTableKeys.has(getTableKey(table))) {
        count += 1;
      }
    }
    return count;
  }, [deselectedTableKeys, filteredTables]);

  const sqlSchemaMap = useMemo(() => {
    const map: Record<string, readonly string[]> = {};
    for (const table of schemaCatalog) {
      const cols = table.columns.map((c) => c.name);
      map[getTableKey(table)] = cols;
      if (table.schema === "public") {
        map[table.name] = cols;
      }
    }
    return map;
  }, [schemaCatalog]);

  const currentOptionsSignature = useMemo(() => {
    return JSON.stringify({
      format,
      includeSchema,
      includeData,
      tables: selectedTablesList,
    });
  }, [format, includeSchema, includeData, selectedTablesList]);

  const isPreviewStale =
    previewResult !== null &&
    previewOptionsSignature !== null &&
    previewOptionsSignature !== currentOptionsSignature;

  const canRunBackup =
    (includeSchema || includeData) &&
    (schemaCatalog.length === 0 || selectedTablesList.length > 0);

  const toggleTableSelection = useCallback((key: string, checked: boolean) => {
    setDeselectedTableKeys((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSelectAllTables = useCallback(() => {
    const targets = tableSearch.trim() ? filteredTables : schemaCatalog;
    setDeselectedTableKeys((prev) => {
      const next = new Set(prev);
      for (const table of targets) {
        next.delete(getTableKey(table));
      }
      return next;
    });
  }, [filteredTables, schemaCatalog, tableSearch]);

  const handleClearTables = useCallback(() => {
    const targets = tableSearch.trim() ? filteredTables : schemaCatalog;
    setDeselectedTableKeys((prev) => {
      const next = new Set(prev);
      for (const table of targets) {
        next.add(getTableKey(table));
      }
      return next;
    });
  }, [filteredTables, schemaCatalog, tableSearch]);

  const handleGeneratePreview = useCallback(() => {
    if (!includeSchema && !includeData) {
      setBackupError("Select at least Schema DDL or Row Data.");
      return;
    }
    if (schemaCatalog.length > 0 && selectedTablesList.length === 0) {
      setBackupError("Select at least one table to back up.");
      return;
    }

    setBackupError(null);
    const requestFormat = format;
    const signature = currentOptionsSignature;

    startPreviewTransition(async () => {
      try {
        const res = await generateBackupAction({
          tables: selectedTablesList,
          includeSchema,
          includeData,
          format: requestFormat,
        });

        if (!res.ok) {
          const message = res.error ?? "Failed to generate backup preview.";
          setBackupError(message);
          toast.error("Backup preview failed", { description: message });
          return;
        }

        setPreviewResult(res);
        setPreviewFormat(requestFormat);
        setPreviewOptionsSignature(signature);
        setCopiedPreview(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to generate backup.";
        setBackupError(message);
        toast.error("Backup preview failed", { description: message });
      }
    });
  }, [
    currentOptionsSignature,
    format,
    includeData,
    includeSchema,
    schemaCatalog.length,
    selectedTablesList,
  ]);

  const handleDownloadBackup = useCallback(async () => {
    if (!includeSchema && !includeData) {
      setBackupError("Select at least Schema DDL or Row Data.");
      return;
    }
    if (schemaCatalog.length > 0 && selectedTablesList.length === 0) {
      setBackupError("Select at least one table to download.");
      return;
    }

    setBackupError(null);
    setIsDownloading(true);

    let objectUrl: string | null = null;
    try {
      const response = await fetch("/api/backup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tables: selectedTablesList,
          includeSchema,
          includeData,
          format,
        } satisfies BackupOptions),
      });

      if (!response.ok) {
        let errorMessage = `Backup download failed (${response.status}).`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) {
            errorMessage = payload.error;
          }
        } catch {
          // Non-JSON error response
        }
        setBackupError(errorMessage);
        toast.error("Download failed", { description: errorMessage });
        return;
      }

      const blob = await response.blob();
      const filename = parseFilenameFromDisposition(
        response.headers.get("Content-Disposition"),
        `pgsa-backup.${format}`
      );

      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      toast.success("Backup downloaded", {
        description: `${filename} (${formatBytes(blob.size)})`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Network error during download.";
      setBackupError(message);
      toast.error("Download failed", { description: message });
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      setIsDownloading(false);
    }
  }, [
    format,
    includeData,
    includeSchema,
    schemaCatalog.length,
    selectedTablesList,
  ]);

  const handleCopyPreview = useCallback(async () => {
    if (!previewResult?.content) return;
    try {
      await navigator.clipboard.writeText(previewResult.content);
      setCopiedPreview(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedPreview(false);
      }, 1800);
      toast.success("Copied backup preview to clipboard");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }, [previewResult]);

  const readSqlFile = useCallback(async (file: File) => {
    setFileLoadError(null);
    setRestoreResult(null);

    if (file.size > MAX_RESTORE_SQL_LENGTH) {
      const message = `File "${file.name}" (${formatBytes(file.size)}) exceeds the 10 MB restore limit.`;
      setFileLoadError(message);
      toast.error("File too large", { description: message });
      return;
    }

    try {
      const text = await file.text();
      if (text.length > MAX_RESTORE_SQL_LENGTH) {
        const message = `SQL content exceeds ${MAX_RESTORE_SQL_LENGTH.toLocaleString()} characters.`;
        setFileLoadError(message);
        toast.error("File too large", { description: message });
        return;
      }
      setRestoreSql(text);
      setLoadedFileMeta({ name: file.name, sizeBytes: file.size });
      toast.success(`Loaded ${file.name}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not read selected file.";
      setFileLoadError(message);
      toast.error("Failed to read file", { description: message });
    }
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      void readSqlFile(file);
    },
    [readSqlFile]
  );

  const handleFileDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragActive(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      void readSqlFile(file);
    },
    [readSqlFile]
  );

  const handleClearRestoreScript = useCallback(() => {
    setRestoreSql("");
    setLoadedFileMeta(null);
    setFileLoadError(null);
    setRestoreResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const handleExecuteRestore = useCallback(() => {
    if (!restoreSql.trim() || isRestoring) return;
    setConfirmRestoreOpen(false);
    setRestoreResult(null);

    const payloadSql = restoreSql;
    const useSingleTx = singleTransaction;

    startRestoreTransition(async () => {
      try {
        const res = await restoreSqlAction({
          sql: payloadSql,
          singleTransaction: useSingleTx,
        });
        setRestoreResult(res);
        if (res.ok) {
          toast.success("SQL restore completed", {
            description: `${res.statementsExecuted.toLocaleString()} statement${res.statementsExecuted === 1 ? "" : "s"} in ${res.durationMs} ms`,
          });
          onRestored?.();
        } else {
          toast.error("SQL restore failed", {
            description: res.error ?? "Execution aborted.",
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Restore execution failed.";
        setRestoreResult({
          ok: false,
          statementsExecuted: 0,
          durationMs: 0,
          error: message,
        });
        toast.error("SQL restore failed", { description: message });
      }
    });
  }, [isRestoring, onRestored, restoreSql, singleTransaction]);

  const restoreLineCount = useMemo(() => {
    if (!restoreSql) return 0;
    return restoreSql.split(/\r\n|\r|\n/).length;
  }, [restoreSql]);

  const restoreByteSize = useMemo(() => {
    if (!restoreSql) return 0;
    return new TextEncoder().encode(restoreSql).length;
  }, [restoreSql]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        if (value === "backup" || value === "restore") {
          setActiveTab(value);
        }
      }}
      className="flex h-full min-h-0 flex-col gap-0 bg-white text-zinc-900"
    >
      {/* Top flush header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4">
        <TabsList variant="line" className="gap-4">
          <TabsTrigger value="backup" className="px-1 text-xs font-medium">
            Backup
          </TabsTrigger>
          <TabsTrigger value="restore" className="px-1 text-xs font-medium">
            Restore
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-3 text-xs text-zinc-500 tabular-nums">
          {activeTab === "backup" ? (
            <span>
              {selectedTablesList.length} / {schemaCatalog.length} tables selected
            </span>
          ) : (
            <span>
              {restoreLineCount.toLocaleString()} lines ·{" "}
              {formatBytes(restoreByteSize)}
            </span>
          )}
        </div>
      </div>

      {/* Backup Tab */}
      <TabsContent value="backup" className="min-h-0 flex-1">
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_1fr]">
          {/* Left Configuration Pane */}
          <div className="flex min-h-0 flex-col border-b border-zinc-200 bg-white md:border-r md:border-b-0">
            <div className="flex shrink-0 flex-col gap-4 border-b border-zinc-200 p-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="backup-format-trigger"
                  className="text-xs font-medium text-zinc-700"
                >
                  Format
                </label>
                <Select
                  items={BACKUP_FORMAT_ITEMS}
                  value={format}
                  onValueChange={(value) => {
                    if (value === "sql" || value === "json") {
                      setFormat(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="backup-format-trigger"
                    size="sm"
                    className="w-full border-zinc-200 bg-white text-xs text-zinc-900"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} side="bottom">
                    <SelectGroup>
                      {BACKUP_FORMAT_ITEMS.map((item) => (
                        <SelectItem
                          key={item.value}
                          value={item.value}
                          className="text-xs"
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-zinc-700">
                  Include
                </span>
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="backup-include-schema"
                    className="flex cursor-pointer items-center gap-2.5 text-xs text-zinc-800 select-none"
                  >
                    <Checkbox
                      id="backup-include-schema"
                      checked={includeSchema}
                      onCheckedChange={(checked) =>
                        setIncludeSchema(Boolean(checked))
                      }
                    />
                    <span>Schema DDL</span>
                  </label>
                  <label
                    htmlFor="backup-include-data"
                    className="flex cursor-pointer items-center gap-2.5 text-xs text-zinc-800 select-none"
                  >
                    <Checkbox
                      id="backup-include-data"
                      checked={includeData}
                      onCheckedChange={(checked) =>
                        setIncludeData(Boolean(checked))
                      }
                    />
                    <span>Row Data</span>
                  </label>
                </div>
                {!includeSchema && !includeData && (
                  <p className="text-[11px] text-red-600">
                    Select at least Schema DDL or Row Data.
                  </p>
                )}
              </div>
            </div>

            {/* Table Checklist */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-col gap-2 border-b border-zinc-200 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-zinc-700">
                    Tables
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleSelectAllTables}
                      disabled={
                        filteredTables.length === 0 ||
                        filteredSelectedCount === filteredTables.length
                      }
                    >
                      Select All
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={handleClearTables}
                      disabled={filteredSelectedCount === 0}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="relative">
                  <HugeiconsIcon
                    icon={Search01Icon}
                    strokeWidth={1.8}
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500"
                  />
                  <Input
                    value={tableSearch}
                    onChange={(event) => setTableSearch(event.target.value)}
                    placeholder="Filter tables..."
                    aria-label="Filter tables"
                    className="h-7 border-zinc-200 bg-zinc-50/60 pl-8 text-xs placeholder:text-zinc-500 focus-visible:bg-white"
                  />
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                {schemaCatalog.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
                    <p className="text-xs font-medium text-zinc-700">
                      No user tables found
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      Create or restore tables to include them in backups.
                    </p>
                  </div>
                ) : filteredTables.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
                    <p className="text-xs text-zinc-500">
                      No tables match &ldquo;{tableSearch.trim()}&rdquo;
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setTableSearch("")}
                    >
                      Reset filter
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col py-1">
                    {filteredTables.map((table) => {
                      const key = getTableKey(table);
                      const isChecked = !deselectedTableKeys.has(key);
                      const checkboxId = `backup-table-${key}`;
                      return (
                        <label
                          key={key}
                          htmlFor={checkboxId}
                          className="flex cursor-pointer items-center justify-between gap-2 px-4 py-1.5 text-xs transition-colors hover:bg-zinc-50"
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <Checkbox
                              id={checkboxId}
                              checked={isChecked}
                              onCheckedChange={(checked) =>
                                toggleTableSelection(key, Boolean(checked))
                              }
                            />
                            <span className="truncate font-mono text-[12px]">
                              <span className="text-zinc-500">
                                {table.schema}.
                              </span>
                              <span className="text-zinc-900">{table.name}</span>
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-zinc-500 tabular-nums">
                            {table.rowEstimate.toLocaleString()}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>

            {/* Footer Action Buttons */}
            <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-200 bg-zinc-50/70 p-3">
              {backupError && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/70 px-2.5 py-2 text-[11px] text-red-700">
                  <HugeiconsIcon
                    icon={AlertCircleIcon}
                    strokeWidth={2}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="min-w-0 break-words">{backupError}</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canRunBackup || isPreviewing || isDownloading}
                  onClick={handleGeneratePreview}
                >
                  {isPreviewing ? (
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      strokeWidth={2}
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={EyeIcon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                  )}
                  Preview
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={!canRunBackup || isDownloading || isPreviewing}
                  onClick={handleDownloadBackup}
                >
                  {isDownloading ? (
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      strokeWidth={2}
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={Download01Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                  )}
                  Download
                </Button>
              </div>
            </div>
          </div>

          {/* Right Preview Pane */}
          <div className="flex min-h-0 min-w-0 flex-col bg-white">
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/70 px-4">
              {previewResult ? (
                <div className="flex min-w-0 items-center gap-2.5 text-xs text-zinc-600 tabular-nums">
                  <span className="truncate font-mono font-medium text-zinc-900">
                    {previewResult.filename}
                  </span>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span className="shrink-0">
                    {formatBytes(previewResult.sizeBytes)}
                  </span>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span className="shrink-0">
                    {previewResult.statementCount.toLocaleString()}{" "}
                    {previewFormat === "json"
                      ? previewResult.statementCount === 1
                        ? "table"
                        : "tables"
                      : previewResult.statementCount === 1
                        ? "statement"
                        : "statements"}
                  </span>
                  <Separator orientation="vertical" className="h-3.5" />
                  <span className="shrink-0">
                    {previewResult.rowCount.toLocaleString()}{" "}
                    {previewResult.rowCount === 1 ? "row" : "rows"}
                  </span>
                  {isPreviewStale && (
                    <>
                      <Separator orientation="vertical" className="h-3.5" />
                      <span className="shrink-0 text-amber-700">
                        Options changed
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <span className="text-xs text-zinc-500">
                  Backup preview output
                </span>
              )}

              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!previewResult?.content}
                onClick={handleCopyPreview}
              >
                <HugeiconsIcon
                  icon={copiedPreview ? Tick02Icon : Copy01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                {copiedPreview ? "Copied" : "Copy"}
              </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {previewResult ? (
                previewFormat === "sql" ? (
                  <SqlEditor
                    value={previewResult.content}
                    onChange={NOOP}
                    schema={sqlSchemaMap}
                    readOnly
                    className="min-h-0 flex-1 rounded-none border-0 focus-within:border-transparent focus-within:ring-0"
                  />
                ) : (
                  <JsonbViewer
                    value={previewResult.content}
                    readOnly
                    className="min-h-0 flex-1 rounded-none border-0 focus-within:border-transparent focus-within:ring-0"
                  />
                )
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                  <div className="flex size-9 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-500">
                    <HugeiconsIcon
                      icon={DatabaseExportIcon}
                      strokeWidth={1.7}
                      className="size-4"
                    />
                  </div>
                  <div className="flex max-w-sm flex-col gap-1">
                    <p className="text-sm font-medium text-zinc-900">
                      Generate a backup preview
                    </p>
                    <p className="text-xs text-zinc-500">
                      Choose SQL Dump or JSON Snapshot, select tables on the
                      left, and preview the output before downloading.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canRunBackup || isPreviewing}
                    onClick={handleGeneratePreview}
                  >
                    {isPreviewing ? (
                      <HugeiconsIcon
                        icon={Loading03Icon}
                        strokeWidth={2}
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={EyeIcon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />
                    )}
                    Generate Preview
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </TabsContent>

      {/* Restore Tab */}
      <TabsContent value="restore" className="min-h-0 flex-1">
        <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[320px_1fr]">
          {/* Left Restore Controls */}
          <div className="flex min-h-0 flex-col justify-between gap-4 overflow-y-auto border-b border-zinc-200 bg-white p-4 md:border-r md:border-b-0">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="restore-sql-file"
                  className="text-xs font-medium text-zinc-700"
                >
                  Load SQL file
                </label>
                <div
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsDragActive(true);
                  }}
                  onDragLeave={() => setIsDragActive(false)}
                  onDrop={handleFileDrop}
                  className={cn(
                    "flex flex-col gap-2 rounded-md border border-dashed p-3 transition-colors",
                    isDragActive
                      ? "border-zinc-900 bg-zinc-100/70"
                      : "border-zinc-300 bg-zinc-50/60"
                  )}
                >
                  <div className="flex items-center gap-2 text-xs text-zinc-600">
                    <HugeiconsIcon
                      icon={Upload01Icon}
                      strokeWidth={1.8}
                      className="size-3.5 shrink-0 text-zinc-500"
                    />
                    <span>Choose or drop a .sql / .txt file</span>
                  </div>
                  <input
                    ref={fileInputRef}
                    id="restore-sql-file"
                    type="file"
                    accept=".sql,.txt"
                    onChange={handleFileInputChange}
                    className="block w-full cursor-pointer text-xs text-zinc-600 file:mr-2.5 file:cursor-pointer file:rounded-md file:border file:border-zinc-200 file:bg-white file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-zinc-800 hover:file:bg-zinc-100"
                  />
                  {loadedFileMeta && (
                    <div className="flex items-center justify-between gap-2 border-t border-zinc-200/80 pt-2 text-[11px] text-zinc-600">
                      <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-zinc-800">
                        <HugeiconsIcon
                          icon={FileCodeIcon}
                          strokeWidth={1.8}
                          className="size-3.5 shrink-0 text-zinc-500"
                        />
                        <span className="truncate">{loadedFileMeta.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-500">
                        {formatBytes(loadedFileMeta.sizeBytes)}
                      </span>
                    </div>
                  )}
                </div>
                {fileLoadError && (
                  <p className="text-[11px] text-red-600">{fileLoadError}</p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-zinc-700">
                  Transaction mode
                </span>
                <label
                  htmlFor="restore-single-transaction"
                  className="flex cursor-pointer items-start gap-2.5 select-none"
                >
                  <Checkbox
                    id="restore-single-transaction"
                    checked={singleTransaction}
                    onCheckedChange={(checked) =>
                      setSingleTransaction(Boolean(checked))
                    }
                    className="mt-0.5"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-zinc-900">
                      Single Transaction (BEGIN / COMMIT)
                    </span>
                    <span className="text-[11px] leading-relaxed text-zinc-500">
                      Executes all statements atomically and rolls back on any
                      error.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-950">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  strokeWidth={1.8}
                  className="mt-0.5 size-4 shrink-0 text-amber-700"
                />
                <p className="leading-relaxed">
                  Restore runs DDL and DML directly against the connected
                  PostgreSQL database. Existing schemas, tables, and rows may be
                  modified or replaced.
                </p>
              </div>

              {restoreResult && (
                <div
                  className={cn(
                    "flex flex-col gap-2 rounded-md border p-3 text-xs",
                    restoreResult.ok
                      ? "border-emerald-200 bg-emerald-50/60 text-emerald-950"
                      : "border-red-200 bg-red-50/60 text-red-950"
                  )}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <HugeiconsIcon
                      icon={
                        restoreResult.ok
                          ? CheckmarkCircle02Icon
                          : AlertCircleIcon
                      }
                      strokeWidth={2}
                      className={cn(
                        "size-4 shrink-0",
                        restoreResult.ok ? "text-emerald-700" : "text-red-700"
                      )}
                    />
                    <span>
                      {restoreResult.ok ? "Restore succeeded" : "Restore failed"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums">
                    <span>
                      Statements executed:{" "}
                      <strong>
                        {restoreResult.statementsExecuted.toLocaleString()}
                      </strong>
                    </span>
                    <span>
                      Duration:{" "}
                      <strong>
                        {restoreResult.durationMs.toLocaleString()} ms
                      </strong>
                    </span>
                  </div>

                  {!restoreResult.ok && restoreResult.error && (
                    <p className="text-[11px] leading-relaxed text-red-800">
                      {restoreResult.error}
                    </p>
                  )}

                  {!restoreResult.ok && restoreResult.failedStatement && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-red-900">
                        Failed statement
                      </span>
                      <pre className="max-h-36 overflow-auto rounded border border-red-200 bg-white p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-red-900">
                        {restoreResult.failedStatement}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-200 pt-3">
              <AlertDialog
                open={confirmRestoreOpen}
                onOpenChange={setConfirmRestoreOpen}
              >
                <AlertDialogTrigger
                  render={
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="w-full"
                      disabled={!restoreSql.trim() || isRestoring}
                    />
                  }
                >
                  {isRestoring ? (
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      strokeWidth={2}
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={DatabaseRestoreIcon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                  )}
                  {isRestoring ? "Restoring..." : "Execute Restore"}
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Execute SQL restore?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will execute {formatBytes(restoreByteSize)} (
                      {restoreLineCount.toLocaleString()} lines) against the
                      live PostgreSQL database{" "}
                      {singleTransaction
                        ? "inside a single BEGIN / COMMIT transaction."
                        : "with auto-commit per statement (partial changes will persist if a statement fails)."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isRestoring}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={isRestoring}
                      onClick={handleExecuteRestore}
                    >
                      Execute Restore
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          {/* Right Restore SQL Editor */}
          <div className="flex min-h-0 min-w-0 flex-col bg-white">
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/70 px-4">
              <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-600 tabular-nums">
                <span className="font-medium text-zinc-900">Restore SQL</span>
                {loadedFileMeta && (
                  <>
                    <Separator orientation="vertical" className="h-3.5" />
                    <span className="truncate font-mono text-zinc-600">
                      {loadedFileMeta.name}
                    </span>
                  </>
                )}
              </div>
              {restoreSql.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={isRestoring}
                  onClick={handleClearRestoreScript}
                >
                  Clear
                </Button>
              )}
            </div>

            <SqlEditor
              value={restoreSql}
              onChange={(next) => {
                setRestoreSql(next);
                if (restoreResult) {
                  setRestoreResult(null);
                }
              }}
              schema={sqlSchemaMap}
              placeholder="Paste SQL dump statements here or choose a .sql file on the left..."
              className="min-h-0 flex-1 rounded-none border-0 focus-within:border-transparent focus-within:ring-0"
            />
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
}

export default BackupRestoreView;
