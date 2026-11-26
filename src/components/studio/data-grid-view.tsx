"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  BracesIcon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  GridTableIcon,
  Key01Icon,
  Loading03Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  RefreshIcon,
  Rows3Icon,
  Search01Icon,
  SlidersHorizontalIcon,
  SqlIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import {
  deleteTableRowsAction,
  insertTableRowAction,
  updateTableCellAction,
} from "@/app/actions";
import { JsonbViewer, formatJsonb } from "@/components/jsonb-viewer";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
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

export interface SortState {
  column: string;
  direction: "asc" | "desc";
}

export interface DataGridServerPagination {
  page: number;
  pageSize: number;
  totalRows: number;
  search: string;
  sort: SortState | null;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onSortChange: (sort: SortState | null) => void;
  onSearchChange: (search: string) => void;
}

export interface DataGridViewProps {
  activeTable: TableSchema | null;
  result: QueryExecutionResult | null;
  isLoading?: boolean;
  onRefresh: () => void;
  onResultUpdated: (
    updater: (prev: QueryExecutionResult) => QueryExecutionResult
  ) => void;
  onOpenSqlTab?: (initialSql?: string) => void;
  serverPagination?: DataGridServerPagination;
}

interface FocusedCell {
  rowIndex: number;
  colIndex: number;
}

interface EditingCellState {
  sessionId: number;
  rowIndex: number;
  colIndex: number;
  column: PostgresColumn;
  draft: string;
  isNull: boolean;
  primaryKeyValues: Record<string, PostgresValue>;
  originalValue: PostgresValue;
}

interface ContextCellTarget {
  rowIndex: number;
  colIndex: number;
  column: PostgresColumn;
  cellValue: PostgresValue;
  row: PostgresRow;
}

interface InspectorPayload {
  title: string;
  subtitle: string;
  activeMode: "jsonb" | "row";
  jsonbColumn?: string;
  jsonbValue?: PostgresValue;
  rowValue: PostgresRow;
  editable: boolean;
  sourceTable?: string;
  primaryKeyValues?: Record<string, PostgresValue>;
}

interface OptimisticCellMutation {
  primaryKeyColumns: string[];
  primaryKeyValues: Record<string, PostgresValue>;
  columnName: string;
  nextValue: PostgresValue;
}

type InsertFieldMode = "value" | "null" | "default";

interface InsertFieldDraft {
  mode: InsertFieldMode;
  value: string;
}

interface DeleteTarget {
  primaryKeys: Array<Record<string, PostgresValue>>;
  description: string;
}

type GridDensity = "default" | "dense";

const HASH_SORT_KEY = "__pgsa_hash__";

const PAGE_SIZE_ITEMS = [
  { label: "10", value: "10" },
  { label: "25", value: "25" },
  { label: "50", value: "50" },
  { label: "100", value: "100" },
  { label: "All", value: "0" },
] as const;

const BOOLEAN_SELECT_ITEMS = [
  { label: "true", value: "true" },
  { label: "false", value: "false" },
] as const;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isUuidColumnOrValue(
  column: PostgresColumn,
  value: PostgresValue
): boolean {
  if (column.dataType === "uuid" || column.dataType === "uuid[]") {
    return true;
  }
  return typeof value === "string" && UUID_REGEX.test(value);
}

function isJsonbColumnType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return lower === "jsonb" || lower === "json";
}

function isJsonbColumnValue(
  column: PostgresColumn,
  value: PostgresValue
): boolean {
  if (value === null) return false;
  return (
    isJsonbColumnType(column.dataType) ||
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

function isBooleanDataType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return lower === "bool" || lower === "boolean";
}

function isTextDataType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return (
    lower === "text" ||
    lower === "varchar" ||
    lower === "bpchar" ||
    lower === "char" ||
    lower === "name" ||
    lower === "citext"
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
    case "paid":
    case "success":
    case "verified":
    case "approved":
    case "open":
    case "published":
      return "bg-emerald-500";
    case "pending":
    case "slow":
    case "paused":
    case "idle":
    case "invited":
    case "warning":
    case "processing":
    case "queued":
    case "trial":
    case "draft":
      return "bg-amber-500";
    case "suspended":
    case "disabled":
    case "failed":
    case "error":
    case "offline":
    case "canceled":
    case "cancelled":
    case "revoked":
    case "blocked":
    case "closed":
      return "bg-rose-500";
    default:
      return "bg-zinc-400";
  }
}

function formatUtcTimestamp(isoValue: string): string {
  if (ISO_TIMESTAMP_REGEX.test(isoValue)) {
    return `${isoValue.slice(0, 19).replace("T", " ")} UTC`;
  }
  return isoValue;
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

function findPrimaryJsonbColumn(
  columns: PostgresColumn[],
  row: PostgresRow
): PostgresColumn | undefined {
  return columns.find((col) => isJsonbColumnValue(col, row[col.name] ?? null));
}

function stringifyCellForSearch(value: PostgresValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function stringifyCellForCopy(value: PostgresValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function stringifyCellForDraft(value: PostgresValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
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

function extractPrimaryKeyValues(
  row: PostgresRow,
  pkColumns: string[]
): Record<string, PostgresValue> | null {
  if (pkColumns.length === 0) return null;
  const pkMap: Record<string, PostgresValue> = {};
  for (const col of pkColumns) {
    const val = row[col];
    if (val === undefined || val === null) {
      return null;
    }
    pkMap[col] = val;
  }
  return pkMap;
}

function serializePrimaryKey(pkValues: Record<string, PostgresValue>): string {
  return JSON.stringify(pkValues);
}

function doesRowMatchPrimaryKey(
  row: PostgresRow,
  pkColumns: string[],
  pkValues: Record<string, PostgresValue>
): boolean {
  if (pkColumns.length === 0) return false;
  return pkColumns.every((col) => {
    const left = row[col];
    const right = pkValues[col];
    if (typeof left === "object" || typeof right === "object") {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    return Object.is(left, right);
  });
}

function parseCellInputValue(
  draft: string,
  isNull: boolean,
  column: PostgresColumn,
  allowEmptyToNull: boolean
): { ok: true; value: PostgresValue } | { ok: false; error: string } {
  if (isNull) {
    if (!column.nullable) {
      return {
        ok: false,
        error: `Column "${column.name}" is NOT NULL.`,
      };
    }
    return { ok: true, value: null };
  }

  const trimmed = draft.trim();
  const dataType = column.dataType.toLowerCase();

  if (trimmed === "" && !isTextDataType(dataType)) {
    if (allowEmptyToNull && column.nullable) {
      return { ok: true, value: null };
    }
    return {
      ok: false,
      error: `Column "${column.name}" (${column.dataType}) requires a value.`,
    };
  }

  if (isBooleanDataType(dataType)) {
    const lowered = trimmed.toLowerCase();
    if (lowered === "true" || lowered === "t" || lowered === "1") {
      return { ok: true, value: true };
    }
    if (lowered === "false" || lowered === "f" || lowered === "0") {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      error: `Expected true or false for "${column.name}".`,
    };
  }

  if (dataType === "int2" || dataType === "int4" || dataType === "oid") {
    if (!/^-?\d+$/.test(trimmed)) {
      return {
        ok: false,
        error: `Expected a valid integer for "${column.name}".`,
      };
    }
    const parsedInt = Number(trimmed);
    if (!Number.isSafeInteger(parsedInt)) {
      return {
        ok: false,
        error: `Integer out of safe range for "${column.name}".`,
      };
    }
    return { ok: true, value: parsedInt };
  }

  if (dataType === "int8") {
    if (!/^-?\d+$/.test(trimmed)) {
      return {
        ok: false,
        error: `Expected a valid 64-bit integer for "${column.name}".`,
      };
    }
    return { ok: true, value: trimmed };
  }

  if (dataType === "float4" || dataType === "float8") {
    const parsedFloat = Number(trimmed);
    if (!Number.isFinite(parsedFloat)) {
      return {
        ok: false,
        error: `Expected a valid number for "${column.name}".`,
      };
    }
    return { ok: true, value: parsedFloat };
  }

  if (dataType === "json" || dataType === "jsonb") {
    try {
      const parsedJson = JSON.parse(draft) as PostgresValue;
      return { ok: true, value: parsedJson };
    } catch {
      return {
        ok: false,
        error: `Invalid JSON payload for "${column.name}".`,
      };
    }
  }

  if (dataType.endsWith("[]") && trimmed.startsWith("[")) {
    try {
      const parsedArr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsedArr)) {
        return { ok: true, value: parsedArr as PostgresValue };
      }
    } catch {
      return {
        ok: false,
        error: `Invalid JSON array for "${column.name}".`,
      };
    }
  }

  return { ok: true, value: draft };
}

function buildInitialInsertDrafts(
  columns: PostgresColumn[],
  pkColumns: string[]
): Record<string, InsertFieldDraft> {
  const pkSet = new Set(pkColumns);
  const drafts: Record<string, InsertFieldDraft> = {};
  for (const col of columns) {
    const isAutoLike =
      pkSet.has(col.name) ||
      col.name === "created_at" ||
      col.name === "updated_at";

    if (isAutoLike || col.nullable) {
      drafts[col.name] = {
        mode: "default",
        value: isBooleanDataType(col.dataType)
          ? "false"
          : isJsonbColumnType(col.dataType)
            ? "{}"
            : "",
      };
    } else {
      drafts[col.name] = {
        mode: "value",
        value: isBooleanDataType(col.dataType)
          ? "false"
          : isJsonbColumnType(col.dataType)
            ? "{}"
            : "",
      };
    }
  }
  return drafts;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildDefaultSelectSql(table: TableSchema): string {
  return `SELECT * FROM ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)} LIMIT 50;`;
}

export function DataGridView({
  activeTable,
  result,
  isLoading = false,
  onRefresh,
  onResultUpdated,
  onOpenSqlTab,
  serverPagination,
}: DataGridViewProps) {
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const editSessionCounterRef = useRef<number>(0);
  const selectAllOnMountRef = useRef<boolean>(true);
  const editFinalizeLockRef = useRef<boolean>(false);
  const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const isServerPaginated = Boolean(serverPagination);

  const scopeKey = useMemo(() => {
    const tablePart = activeTable
      ? `${activeTable.schema}.${activeTable.name}`
      : result?.sourceTable ?? "";
    const colPart = (result?.columns ?? []).map((c) => c.name).join(",");
    return `${tablePart}::${colPart}`;
  }, [activeTable, result?.sourceTable, result?.columns]);

  const [clientRowFilter, setClientRowFilter] = useState<string>("");
  const externalSearch = serverPagination?.search ?? "";
  const [serverSearchState, setServerSearchState] = useState<{
    scope: string;
    syncedExternal: string;
    draft: string;
  }>({
    scope: scopeKey,
    syncedExternal: externalSearch,
    draft: externalSearch,
  });

  if (
    serverSearchState.scope !== scopeKey ||
    serverSearchState.syncedExternal !== externalSearch
  ) {
    setServerSearchState({
      scope: scopeKey,
      syncedExternal: externalSearch,
      draft: externalSearch,
    });
  }

  const searchInputValue = isServerPaginated
    ? serverSearchState.draft
    : clientRowFilter;

  const [density, setDensity] = useState<GridDensity>("default");
  const [clientPageSize, setClientPageSize] = useState<number>(50);
  const [virtualScroll, setVirtualScroll] = useState<{
    scrollTop: number;
    viewportHeight: number;
  }>({ scrollTop: 0, viewportHeight: 720 });
  const scrollRafRef = useRef<number | null>(null);

  const [scopedSort, setScopedSort] = useState<{
    scope: string;
    sort: SortState | null;
  }>({ scope: scopeKey, sort: null });
  const [scopedHiddenCols, setScopedHiddenCols] = useState<{
    scope: string;
    cols: Record<string, boolean>;
  }>({ scope: scopeKey, cols: {} });
  const [scopedPage, setScopedPage] = useState<{
    scope: string;
    page: number;
  }>({ scope: scopeKey, page: 1 });
  const [scopedSelection, setScopedSelection] = useState<{
    scope: string;
    keys: string[];
  }>({ scope: scopeKey, keys: [] });

  const [focusedCell, setFocusedCell] = useState<FocusedCell | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCellState | null>(null);
  const [contextTarget, setContextTarget] = useState<ContextCellTarget | null>(
    null
  );

  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const [inspectorJsonDraft, setInspectorJsonDraft] = useState<string>("");

  const [isAddSheetOpen, setIsAddSheetOpen] = useState<boolean>(false);
  const [insertDrafts, setInsertDrafts] = useState<
    Record<string, InsertFieldDraft>
  >({});
  const [insertError, setInsertError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [isSavingCell, startSaveCellTransition] = useTransition();
  const [isInsertingRow, startInsertTransition] = useTransition();
  const [isDeletingRows, startDeleteTransition] = useTransition();

  const sortState = serverPagination
    ? serverPagination.sort
    : scopedSort.scope === scopeKey
      ? scopedSort.sort
      : null;
  const hiddenColumns = useMemo(
    () => (scopedHiddenCols.scope === scopeKey ? scopedHiddenCols.cols : {}),
    [scopedHiddenCols, scopeKey]
  );
  const currentPage = serverPagination
    ? serverPagination.page
    : scopedPage.scope === scopeKey
      ? scopedPage.page
      : 1;
  const effectivePageSize = serverPagination
    ? serverPagination.pageSize
    : clientPageSize;
  const selectedKeyList = useMemo(
    () => (scopedSelection.scope === scopeKey ? scopedSelection.keys : []),
    [scopedSelection, scopeKey]
  );

  const setClientSortState = useCallback(
    (updater: (prev: SortState | null) => SortState | null) => {
      setScopedSort((prev) => ({
        scope: scopeKey,
        sort: updater(prev.scope === scopeKey ? prev.sort : null),
      }));
    },
    [scopeKey]
  );

  const setHiddenColumns = useCallback(
    (
      updater: (prev: Record<string, boolean>) => Record<string, boolean>
    ) => {
      setScopedHiddenCols((prev) => ({
        scope: scopeKey,
        cols: updater(prev.scope === scopeKey ? prev.cols : {}),
      }));
    },
    [scopeKey]
  );

  const setCurrentPage = useCallback(
    (nextPage: number) => {
      if (serverPagination) {
        serverPagination.onPageChange(nextPage);
      } else {
        setScopedPage({ scope: scopeKey, page: nextPage });
      }
    },
    [scopeKey, serverPagination]
  );

  const setSelectedKeyList = useCallback(
    (updater: (prev: string[]) => string[]) => {
      setScopedSelection((prev) => ({
        scope: scopeKey,
        keys: updater(prev.scope === scopeKey ? prev.keys : []),
      }));
    },
    [scopeKey]
  );

  const [optimisticRows, addOptimisticCell] = useOptimistic<
    PostgresRow[],
    OptimisticCellMutation
  >(result?.rows ?? [], (currentRows, mutation) =>
    currentRows.map((row) =>
      doesRowMatchPrimaryKey(
        row,
        mutation.primaryKeyColumns,
        mutation.primaryKeyValues
      )
        ? { ...row, [mutation.columnName]: mutation.nextValue }
        : row
    )
  );

  const activeEditSessionKey = editingCell
    ? `${editingCell.rowIndex}:${editingCell.colIndex}:${editingCell.sessionId}`
    : null;

  useEffect(() => {
    if (!activeEditSessionKey) return;
    editFinalizeLockRef.current = false;
    const input = inlineInputRef.current;
    if (!input) return;
    input.focus();
    if (selectAllOnMountRef.current) {
      input.select();
    } else {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }, [activeEditSessionKey]);

  useEffect(() => {
    return () => {
      if (searchDebounceTimerRef.current) {
        clearTimeout(searchDebounceTimerRef.current);
      }
    };
  }, []);

  const targetTableName = useMemo(() => {
    if (result?.sourceTable) return result.sourceTable;
    if (activeTable) return `${activeTable.schema}.${activeTable.name}`;
    return undefined;
  }, [activeTable, result]);

  const primaryKeyColumns = useMemo(() => {
    const resultPks = result?.primaryKeyColumns;
    if (resultPks && resultPks.length > 0) {
      return resultPks;
    }
    if (
      activeTable &&
      targetTableName === `${activeTable.schema}.${activeTable.name}`
    ) {
      return activeTable.primaryKeyColumns;
    }
    return [];
  }, [activeTable, result, targetTableName]);

  const resultColumns = useMemo(
    () => result?.columns ?? activeTable?.columns ?? [],
    [activeTable, result]
  );

  const insertSchemaColumns = useMemo(() => {
    if (
      activeTable &&
      targetTableName === `${activeTable.schema}.${activeTable.name}` &&
      activeTable.columns.length > 0
    ) {
      return activeTable.columns;
    }
    return result?.columns ?? [];
  }, [activeTable, result, targetTableName]);

  const visibleColumns = useMemo(
    () => resultColumns.filter((col) => !hiddenColumns[col.name]),
    [hiddenColumns, resultColumns]
  );

  const canInlineEdit = Boolean(
    result?.editable &&
      result.sourceTable &&
      result.primaryKeyColumns &&
      result.primaryKeyColumns.length > 0
  );

  const canMutateRows = Boolean(
    targetTableName &&
      primaryKeyColumns.length > 0 &&
      (result ? result.editable !== false : true)
  );

  const filteredRows = useMemo(() => {
    if (isServerPaginated) return optimisticRows;
    const term = clientRowFilter.trim().toLowerCase();
    if (!term) return optimisticRows;
    return optimisticRows.filter((row) =>
      Object.values(row).some((val) =>
        stringifyCellForSearch(val).toLowerCase().includes(term)
      )
    );
  }, [clientRowFilter, isServerPaginated, optimisticRows]);

  const sortedRows = useMemo(() => {
    if (isServerPaginated || !sortState) return filteredRows;
    if (sortState.column === HASH_SORT_KEY) {
      return sortState.direction === "desc"
        ? [...filteredRows].reverse()
        : filteredRows;
    }
    return [...filteredRows].sort((leftRow, rightRow) =>
      compareCellValues(
        leftRow[sortState.column] ?? null,
        rightRow[sortState.column] ?? null,
        sortState.direction
      )
    );
  }, [filteredRows, isServerPaginated, sortState]);

  const showAllRows = effectivePageSize === 0;
  const totalRowsCount = serverPagination
    ? serverPagination.totalRows
    : sortedRows.length;
  const totalPages = showAllRows
    ? 1
    : Math.max(1, Math.ceil(totalRowsCount / effectivePageSize));
  const safePage = showAllRows
    ? 1
    : Math.min(Math.max(1, currentPage), totalPages);
  const pageStartIndex = showAllRows ? 0 : (safePage - 1) * effectivePageSize;

  const paginatedRows = useMemo(() => {
    if (isServerPaginated || showAllRows) return sortedRows;
    return sortedRows.slice(
      pageStartIndex,
      pageStartIndex + effectivePageSize
    );
  }, [
    effectivePageSize,
    isServerPaginated,
    pageStartIndex,
    showAllRows,
    sortedRows,
  ]);

  const rowHeightPx = density === "dense" ? 36 : 44;
  const shouldVirtualize = paginatedRows.length > 100;
  const virtualOverscan = 12;
  const virtualStartIndex = shouldVirtualize
    ? Math.max(
        0,
        Math.floor(Math.max(0, virtualScroll.scrollTop - 40) / rowHeightPx) -
          virtualOverscan
      )
    : 0;
  const virtualEndIndex = shouldVirtualize
    ? Math.min(
        paginatedRows.length,
        Math.ceil(
          (virtualScroll.scrollTop + virtualScroll.viewportHeight) / rowHeightPx
        ) + virtualOverscan
      )
    : paginatedRows.length;
  const renderedRows = shouldVirtualize
    ? paginatedRows.slice(virtualStartIndex, virtualEndIndex)
    : paginatedRows;
  const topSpacerHeight = virtualStartIndex * rowHeightPx;
  const bottomSpacerHeight = Math.max(
    0,
    (paginatedRows.length - virtualEndIndex) * rowHeightPx
  );

  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el) return;

    const syncHeight = () => {
      const nextHeight = el.clientHeight || 720;
      setVirtualScroll((prev) =>
        prev.viewportHeight === nextHeight
          ? prev
          : { ...prev, viewportHeight: nextHeight }
      );
    };
    syncHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncHeight);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const handleGridScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!shouldVirtualize) return;
      const target = event.currentTarget;
      const nextTop = target.scrollTop;
      const nextHeight = target.clientHeight || 720;
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
      scrollRafRef.current = requestAnimationFrame(() => {
        setVirtualScroll((prev) => {
          if (
            Math.abs(prev.scrollTop - nextTop) < rowHeightPx &&
            prev.viewportHeight === nextHeight
          ) {
            return prev;
          }
          return { scrollTop: nextTop, viewportHeight: nextHeight };
        });
      });
    },
    [rowHeightPx, shouldVirtualize]
  );

  const showingFrom =
    totalRowsCount === 0 || paginatedRows.length === 0
      ? 0
      : pageStartIndex + 1;
  const showingTo =
    totalRowsCount === 0 || paginatedRows.length === 0
      ? 0
      : Math.min(pageStartIndex + paginatedRows.length, totalRowsCount);

  const rowKeyByRow = useMemo(() => {
    const map = new Map<PostgresRow, string>();
    if (primaryKeyColumns.length === 0) return map;
    for (const row of optimisticRows) {
      const pk = extractPrimaryKeyValues(row, primaryKeyColumns);
      if (pk) {
        map.set(row, serializePrimaryKey(pk));
      }
    }
    return map;
  }, [optimisticRows, primaryKeyColumns]);

  const selectedKeySet = useMemo(() => {
    const valid = new Set(rowKeyByRow.values());
    const next = new Set<string>();
    for (const key of selectedKeyList) {
      if (valid.has(key)) next.add(key);
    }
    return next;
  }, [rowKeyByRow, selectedKeyList]);

  const pageSelectableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const row of paginatedRows) {
      const key = rowKeyByRow.get(row);
      if (key) keys.push(key);
    }
    return keys;
  }, [paginatedRows, rowKeyByRow]);

  const allPageSelected =
    pageSelectableKeys.length > 0 &&
    pageSelectableKeys.every((key) => selectedKeySet.has(key));
  const somePageSelected = pageSelectableKeys.some((key) =>
    selectedKeySet.has(key)
  );

  const handleToggleSelectAllPage = useCallback(
    (checked: boolean) => {
      if (pageSelectableKeys.length === 0) return;
      setSelectedKeyList((prev) => {
        const next = new Set(prev);
        if (checked) {
          for (const key of pageSelectableKeys) next.add(key);
        } else {
          for (const key of pageSelectableKeys) next.delete(key);
        }
        return Array.from(next);
      });
    },
    [pageSelectableKeys, setSelectedKeyList]
  );

  const handleToggleSelectRow = useCallback(
    (rowKey: string, checked: boolean) => {
      setSelectedKeyList((prev) => {
        const next = new Set(prev);
        if (checked) next.add(rowKey);
        else next.delete(rowKey);
        return Array.from(next);
      });
    },
    [setSelectedKeyList]
  );

  const handleCopyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error(`Clipboard unavailable for ${label}`);
    }
  }, []);

  const focusGridCellElement = useCallback(
    (rowIndex: number, colIndex: number) => {
      setFocusedCell({ rowIndex, colIndex });
      requestAnimationFrame(() => {
        const el = tableContainerRef.current?.querySelector<HTMLElement>(
          `[data-grid-cell="${rowIndex}:${colIndex}"]`
        );
        el?.focus();
      });
    },
    []
  );

  const beginInlineEdit = useCallback(
    (
      rowIndex: number,
      colIndex: number,
      column: PostgresColumn,
      row: PostgresRow,
      options?: { initialDraft?: string; selectAll?: boolean }
    ) => {
      const pkCols = result?.primaryKeyColumns;
      if (!canInlineEdit || !pkCols) return;

      const pkValues = extractPrimaryKeyValues(row, pkCols);
      if (!pkValues) {
        toast.error("Cannot edit row without primary key values");
        return;
      }

      const currentVal = row[column.name] ?? null;
      const hasInitialDraft = options?.initialDraft !== undefined;
      editSessionCounterRef.current += 1;
      selectAllOnMountRef.current =
        options?.selectAll ?? !hasInitialDraft;
      editFinalizeLockRef.current = false;

      setFocusedCell({ rowIndex, colIndex });
      setEditingCell({
        sessionId: editSessionCounterRef.current,
        rowIndex,
        colIndex,
        column,
        draft: hasInitialDraft
          ? options.initialDraft!
          : stringifyCellForDraft(currentVal),
        isNull: hasInitialDraft ? false : currentVal === null,
        primaryKeyValues: pkValues,
        originalValue: currentVal,
      });
    },
    [canInlineEdit, result]
  );

  const commitCellUpdate = useCallback(
    (
      targetTable: string,
      pkColumns: string[],
      pkValues: Record<string, PostgresValue>,
      columnName: string,
      nextValue: PostgresValue
    ) => {
      startSaveCellTransition(async () => {
        addOptimisticCell({
          primaryKeyColumns: pkColumns,
          primaryKeyValues: pkValues,
          columnName,
          nextValue,
        });

        try {
          const res = await updateTableCellAction({
            table: targetTable,
            primaryKey: pkValues,
            column: columnName,
            value: nextValue,
          });

          if (!res.ok) {
            toast.error(`Failed to update "${columnName}"`, {
              description: res.error ?? "PostgreSQL rejected the update.",
            });
            return;
          }

          const persistedValue =
            res.value !== undefined ? res.value : nextValue;

          onResultUpdated((prev) => ({
            ...prev,
            rows: prev.rows.map((r) =>
              doesRowMatchPrimaryKey(r, pkColumns, pkValues)
                ? { ...r, [columnName]: persistedValue }
                : r
            ),
          }));

          toast.success(`Saved ${columnName}`);
        } catch (err) {
          toast.error(`Update failed for "${columnName}"`, {
            description:
              err instanceof Error ? err.message : "Unexpected server error.",
          });
        }
      });
    },
    [addOptimisticCell, onResultUpdated]
  );

  const finishInlineEdit = useCallback(
    (
      mode: "save" | "cancel" | "blur",
      moveAfterSave?: "next" | "prev"
    ) => {
      if (!editingCell || editFinalizeLockRef.current) return;

      if (mode === "cancel") {
        editFinalizeLockRef.current = true;
        const { rowIndex, colIndex } = editingCell;
        setEditingCell(null);
        focusGridCellElement(rowIndex, colIndex);
        return;
      }

      if (!result?.sourceTable || !result.primaryKeyColumns) {
        editFinalizeLockRef.current = true;
        setEditingCell(null);
        return;
      }

      const parsed = parseCellInputValue(
        editingCell.draft,
        editingCell.isNull,
        editingCell.column,
        true
      );
      if (!parsed.ok) {
        toast.error("Invalid cell value", { description: parsed.error });
        if (mode === "blur") {
          editFinalizeLockRef.current = true;
          setEditingCell(null);
        }
        return;
      }

      editFinalizeLockRef.current = true;
      const orig = editingCell.originalValue;
      const next = parsed.value;
      const unchanged =
        typeof orig === "object" || typeof next === "object"
          ? JSON.stringify(orig) === JSON.stringify(next)
          : Object.is(orig, next);

      const { rowIndex, colIndex, column, primaryKeyValues } = editingCell;
      setEditingCell(null);

      if (moveAfterSave) {
        const maxRow = paginatedRows.length - 1;
        const maxCol = visibleColumns.length - 1;
        let nextRow = rowIndex;
        let nextCol = colIndex;
        if (moveAfterSave === "next") {
          if (colIndex < maxCol) nextCol = colIndex + 1;
          else if (rowIndex < maxRow) {
            nextRow = rowIndex + 1;
            nextCol = 0;
          }
        } else {
          if (colIndex > 0) nextCol = colIndex - 1;
          else if (rowIndex > 0) {
            nextRow = rowIndex - 1;
            nextCol = maxCol;
          }
        }
        focusGridCellElement(nextRow, nextCol);
      } else if (mode === "save") {
        focusGridCellElement(rowIndex, colIndex);
      }

      if (!unchanged) {
        commitCellUpdate(
          result.sourceTable,
          result.primaryKeyColumns,
          primaryKeyValues,
          column.name,
          next
        );
      }
    },
    [
      commitCellUpdate,
      editingCell,
      focusGridCellElement,
      paginatedRows.length,
      result,
      visibleColumns.length,
    ]
  );

  const openInspector = useCallback(
    (
      row: PostgresRow,
      columns: PostgresColumn[],
      rowNumber: number,
      preferredCol?: PostgresColumn
    ) => {
      const primaryJsonb =
        preferredCol ?? findPrimaryJsonbColumn(columns, row);
      const rowLabel =
        typeof row.email === "string"
          ? row.email
          : typeof row.name === "string"
            ? row.name
            : typeof row.id === "string" || typeof row.id === "number"
              ? `Row #${rowNumber} · id ${String(row.id).slice(0, 12)}`
              : `Row #${rowNumber}`;

      const pkCols = result?.primaryKeyColumns;
      const pkValues =
        canInlineEdit && pkCols
          ? (extractPrimaryKeyValues(row, pkCols) ?? undefined)
          : undefined;

      const initialJsonbVal = primaryJsonb ? row[primaryJsonb.name] : undefined;

      setInspector({
        title: primaryJsonb
          ? `${primaryJsonb.name} (${primaryJsonb.dataType})`
          : "Row Payload",
        subtitle: rowLabel,
        activeMode: primaryJsonb ? "jsonb" : "row",
        jsonbColumn: primaryJsonb?.name,
        jsonbValue: initialJsonbVal,
        rowValue: row,
        editable: Boolean(primaryJsonb && pkValues && result?.sourceTable),
        sourceTable: result?.sourceTable,
        primaryKeyValues: pkValues,
      });
      setInspectorJsonDraft(
        primaryJsonb ? formatJsonb(initialJsonbVal) : formatJsonb(row)
      );
    },
    [canInlineEdit, result]
  );

  const handleSaveInspectorJsonb = useCallback(() => {
    const pkCols = result?.primaryKeyColumns;
    if (
      !inspector ||
      !inspector.editable ||
      !inspector.jsonbColumn ||
      !inspector.sourceTable ||
      !inspector.primaryKeyValues ||
      !pkCols
    ) {
      return;
    }

    let parsed: PostgresValue;
    try {
      parsed = JSON.parse(inspectorJsonDraft) as PostgresValue;
    } catch {
      toast.error("Invalid JSON syntax", {
        description: "Fix JSON formatting before saving.",
      });
      return;
    }

    const colName = inspector.jsonbColumn;
    const sourceTable = inspector.sourceTable;
    const pkValues = inspector.primaryKeyValues;

    setInspector(null);
    commitCellUpdate(sourceTable, pkCols, pkValues, colName, parsed);
  }, [commitCellUpdate, inspector, inspectorJsonDraft, result]);

  const handleCellKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTableCellElement>,
      rowIndex: number,
      colIndex: number,
      column: PostgresColumn,
      row: PostgresRow
    ) => {
      if (editingCell) return;

      const maxRow = paginatedRows.length - 1;
      const maxCol = visibleColumns.length - 1;
      if (maxRow < 0 || maxCol < 0) return;

      const cellVal = row[column.name] ?? null;
      const isJsonb = isJsonbColumnValue(column, cellVal);
      const isPk = primaryKeyColumns.includes(column.name);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusGridCellElement(Math.min(maxRow, rowIndex + 1), colIndex);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusGridCellElement(Math.max(0, rowIndex - 1), colIndex);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        focusGridCellElement(rowIndex, Math.min(maxCol, colIndex + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        focusGridCellElement(rowIndex, Math.max(0, colIndex - 1));
      } else if (e.key === "Tab") {
        if (e.shiftKey) {
          if (colIndex > 0) {
            e.preventDefault();
            focusGridCellElement(rowIndex, colIndex - 1);
          } else if (rowIndex > 0) {
            e.preventDefault();
            focusGridCellElement(rowIndex - 1, maxCol);
          }
        } else {
          if (colIndex < maxCol) {
            e.preventDefault();
            focusGridCellElement(rowIndex, colIndex + 1);
          } else if (rowIndex < maxRow) {
            e.preventDefault();
            focusGridCellElement(rowIndex + 1, 0);
          }
        }
      } else if (e.key === "Enter" || e.key === "F2") {
        if (e.target !== e.currentTarget && e.key === "Enter") {
          return;
        }
        e.preventDefault();
        if (isJsonb) {
          openInspector(
            row,
            resultColumns,
            pageStartIndex + rowIndex + 1,
            column
          );
        } else if (canInlineEdit) {
          beginInlineEdit(rowIndex, colIndex, column, row, {
            selectAll: true,
          });
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        const selection = window.getSelection()?.toString();
        if (!selection) {
          e.preventDefault();
          void handleCopyText(
            stringifyCellForCopy(cellVal),
            column.name
          );
        }
      } else if (
        (e.key === "Backspace" || e.key === "Delete") &&
        e.target === e.currentTarget &&
        canInlineEdit &&
        !isJsonb &&
        !isPk
      ) {
        e.preventDefault();
        beginInlineEdit(rowIndex, colIndex, column, row, {
          initialDraft: "",
          selectAll: false,
        });
      } else if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.target === e.currentTarget &&
        canInlineEdit &&
        !isJsonb
      ) {
        e.preventDefault();
        beginInlineEdit(rowIndex, colIndex, column, row, {
          initialDraft: e.key,
          selectAll: false,
        });
      }
    },
    [
      beginInlineEdit,
      canInlineEdit,
      editingCell,
      focusGridCellElement,
      handleCopyText,
      openInspector,
      pageStartIndex,
      paginatedRows.length,
      primaryKeyColumns,
      resultColumns,
      visibleColumns.length,
    ]
  );

  const handleToggleHashOrder = useCallback(() => {
    const computeNext = (prev: SortState | null): SortState | null => {
      if (prev?.column === HASH_SORT_KEY && prev.direction === "desc") {
        return null;
      }
      return { column: HASH_SORT_KEY, direction: "desc" };
    };

    if (serverPagination) {
      serverPagination.onSortChange(computeNext(serverPagination.sort));
    } else {
      setClientSortState(computeNext);
      setCurrentPage(1);
    }
    setFocusedCell(null);
    setEditingCell(null);
  }, [serverPagination, setClientSortState, setCurrentPage]);

  const handleToggleColumnSort = useCallback(
    (columnName: string) => {
      const computeNext = (prev: SortState | null): SortState | null => {
        if (!prev || prev.column !== columnName) {
          return { column: columnName, direction: "asc" };
        }
        if (prev.direction === "asc") {
          return { column: columnName, direction: "desc" };
        }
        return null;
      };

      if (serverPagination) {
        serverPagination.onSortChange(computeNext(serverPagination.sort));
      } else {
        setClientSortState(computeNext);
        setCurrentPage(1);
      }
      setFocusedCell(null);
      setEditingCell(null);
    },
    [serverPagination, setClientSortState, setCurrentPage]
  );

  const handleToggleColumnVisibility = useCallback(
    (columnName: string) => {
      setHiddenColumns((prev) => {
        const currentlyHidden = Boolean(prev[columnName]);
        if (!currentlyHidden && visibleColumns.length <= 1) {
          toast.info("At least one column must remain visible");
          return prev;
        }
        const next = { ...prev };
        if (currentlyHidden) {
          delete next[columnName];
        } else {
          next[columnName] = true;
        }
        return next;
      });
      setFocusedCell(null);
      setEditingCell(null);
    },
    [setHiddenColumns, visibleColumns.length]
  );

  const exportBaseName = useMemo(() => {
    if (targetTableName) return targetTableName.replace(/\./g, "_");
    return (result?.command || "query_result").toLowerCase();
  }, [result?.command, targetTableName]);

  const triggerDownload = useCallback(
    (content: string, mimeType: string, filename: string) => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },
    []
  );

  const handleExportCsv = useCallback(() => {
    if (visibleColumns.length === 0 || sortedRows.length === 0) {
      toast.info("No rows available to export");
      return;
    }
    const headerLine = visibleColumns
      .map((col) => escapeCsvCell(col.name))
      .join(",");
    const dataLines = sortedRows.map((row) =>
      visibleColumns
        .map((col) => escapeCsvCell(row[col.name] ?? null))
        .join(",")
    );
    triggerDownload(
      [headerLine, ...dataLines].join("\r\n"),
      "text/csv;charset=utf-8;",
      `${exportBaseName}.csv`
    );
    toast.success(`Exported ${sortedRows.length} rows as CSV`);
  }, [exportBaseName, sortedRows, triggerDownload, visibleColumns]);

  const handleExportJson = useCallback(() => {
    if (sortedRows.length === 0) {
      toast.info("No rows available to export");
      return;
    }
    triggerDownload(
      formatJsonb(sortedRows),
      "application/json;charset=utf-8;",
      `${exportBaseName}.json`
    );
    toast.success(`Exported ${sortedRows.length} rows as JSON`);
  }, [exportBaseName, sortedRows, triggerDownload]);

  const handleOpenAddSheet = useCallback(() => {
    setInsertDrafts(
      buildInitialInsertDrafts(insertSchemaColumns, primaryKeyColumns)
    );
    setInsertError(null);
    setIsAddSheetOpen(true);
  }, [insertSchemaColumns, primaryKeyColumns]);

  const handleSubmitInsertRow = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!targetTableName) return;

      const values: Record<string, PostgresValue | undefined> = {};
      for (const col of insertSchemaColumns) {
        const draft = insertDrafts[col.name] ?? {
          mode: "default" as const,
          value: "",
        };

        if (draft.mode === "default") {
          values[col.name] = undefined;
          continue;
        }
        if (draft.mode === "null") {
          values[col.name] = null;
          continue;
        }

        const parsed = parseCellInputValue(draft.value, false, col, false);
        if (!parsed.ok) {
          setInsertError(parsed.error);
          return;
        }
        values[col.name] = parsed.value;
      }

      setInsertError(null);
      startInsertTransition(async () => {
        try {
          const res = await insertTableRowAction({
            table: targetTableName,
            values,
          });
          if (!res.ok || !res.row) {
            const msg = res.error ?? "Failed to insert row.";
            setInsertError(msg);
            toast.error("Insert failed", { description: msg });
            return;
          }

          const insertedRow = res.row;
          if (!result || result.columns.length === 0) {
            onRefresh();
          } else {
            onResultUpdated((prev) => {
              const typedPrev = prev as QueryExecutionResult & {
                totalRows?: number;
              };
              const nextTotal =
                typeof typedPrev.totalRows === "number"
                  ? typedPrev.totalRows + 1
                  : undefined;
              return {
                ...prev,
                rows: [insertedRow, ...prev.rows],
                rowCount: prev.rowCount + 1,
                ...(nextTotal !== undefined ? { totalRows: nextTotal } : {}),
              };
            });
          }

          setIsAddSheetOpen(false);
          toast.success(`Inserted row into ${targetTableName}`);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unexpected server error.";
          setInsertError(msg);
          toast.error("Insert failed", { description: msg });
        }
      });
    },
    [
      insertDrafts,
      insertSchemaColumns,
      onRefresh,
      onResultUpdated,
      result,
      targetTableName,
    ]
  );

  const handleRequestBulkDelete = useCallback(() => {
    if (!targetTableName || primaryKeyColumns.length === 0) {
      toast.error("Deletion requires a table with a primary key");
      return;
    }
    const primaryKeys: Array<Record<string, PostgresValue>> = [];
    for (const row of optimisticRows) {
      const key = rowKeyByRow.get(row);
      if (key && selectedKeySet.has(key)) {
        const pk = extractPrimaryKeyValues(row, primaryKeyColumns);
        if (pk) primaryKeys.push(pk);
      }
    }
    if (primaryKeys.length === 0) return;

    setDeleteError(null);
    setDeleteTarget({
      primaryKeys,
      description: `Delete ${primaryKeys.length} selected ${primaryKeys.length === 1 ? "row" : "rows"} from ${targetTableName}? This action cannot be undone.`,
    });
  }, [optimisticRows, primaryKeyColumns, rowKeyByRow, selectedKeySet, targetTableName]);

  const handleRequestSingleRowDelete = useCallback(
    (row: PostgresRow, globalRowNum: number) => {
      if (!targetTableName || primaryKeyColumns.length === 0) {
        toast.error("Deletion requires a table with a primary key");
        return;
      }
      const pk = extractPrimaryKeyValues(row, primaryKeyColumns);
      if (!pk) {
        toast.error("Row is missing primary key values");
        return;
      }
      setDeleteError(null);
      setDeleteTarget({
        primaryKeys: [pk],
        description: `Delete row #${globalRowNum} from ${targetTableName}? This action cannot be undone.`,
      });
    },
    [primaryKeyColumns, targetTableName]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget || !targetTableName) return;

    const pksToDelete = deleteTarget.primaryKeys;
    const deletedKeySet = new Set(
      pksToDelete.map((pk) => serializePrimaryKey(pk))
    );

    setDeleteError(null);
    startDeleteTransition(async () => {
      try {
        const res = await deleteTableRowsAction({
          table: targetTableName,
          primaryKeys: pksToDelete,
        });

        if (!res.ok) {
          const msg = res.error ?? "Database rejected row deletion.";
          setDeleteError(msg);
          toast.error("Delete failed", { description: msg });
          return;
        }

        onResultUpdated((prev) => {
          const typedPrev = prev as QueryExecutionResult & {
            totalRows?: number;
          };
          const nextTotal =
            typeof typedPrev.totalRows === "number"
              ? Math.max(0, typedPrev.totalRows - res.deletedCount)
              : undefined;
          return {
            ...prev,
            rows: prev.rows.filter(
              (r) =>
                !pksToDelete.some((pk) =>
                  doesRowMatchPrimaryKey(r, primaryKeyColumns, pk)
                )
            ),
            rowCount: Math.max(0, prev.rowCount - res.deletedCount),
            ...(nextTotal !== undefined ? { totalRows: nextTotal } : {}),
          };
        });

        if (
          serverPagination &&
          paginatedRows.length <= pksToDelete.length &&
          safePage > 1
        ) {
          serverPagination.onPageChange(safePage - 1);
        }

        setSelectedKeyList((prev) =>
          prev.filter((k) => !deletedKeySet.has(k))
        );
        setDeleteTarget(null);
        toast.success(
          `Deleted ${res.deletedCount} ${res.deletedCount === 1 ? "row" : "rows"}`
        );
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Unexpected server error.";
        setDeleteError(msg);
        toast.error("Delete failed", { description: msg });
      }
    });
  }, [
    deleteTarget,
    onResultUpdated,
    paginatedRows.length,
    primaryKeyColumns,
    safePage,
    serverPagination,
    setSelectedKeyList,
    targetTableName,
  ]);

  const activeInspectorPayload = useMemo(() => {
    if (!inspector) return null;
    if (inspector.activeMode === "jsonb" && inspector.jsonbColumn) {
      return inspector.jsonbValue ?? null;
    }
    return inspector.rowValue;
  }, [inspector]);

  const isInspectorJsonbEditable = Boolean(
    inspector?.editable &&
      inspector.activeMode === "jsonb" &&
      inspector.jsonbColumn
  );

  const headerTitle =
    targetTableName ?? (result?.command ? `${result.command} Result` : "Data Grid");

  const rowHeightClass = density === "dense" ? "h-9" : "h-11";
  const cellPadClass =
    density === "dense" ? "px-2.5 py-1.5 text-[13px]" : "px-3 py-2 text-sm";

  const hiddenCount = Object.keys(hiddenColumns).length;

  const resultTotalRows =
    result &&
    "totalRows" in result &&
    typeof (result as QueryExecutionResult & { totalRows?: number })
      .totalRows === "number"
      ? (result as QueryExecutionResult & { totalRows: number }).totalRows
      : undefined;

  const toolbarDisplayCount = serverPagination
    ? serverPagination.totalRows
    : resultTotalRows ?? result?.rowCount ?? 0;

  const pageSizeSelectItems = useMemo(() => {
    const valStr = String(effectivePageSize);
    if (PAGE_SIZE_ITEMS.some((item) => item.value === valStr)) {
      return [...PAGE_SIZE_ITEMS];
    }
    return [...PAGE_SIZE_ITEMS, { label: valStr, value: valStr }].sort(
      (a, b) => {
        if (a.value === "0") return 1;
        if (b.value === "0") return -1;
        return Number(a.value) - Number(b.value);
      }
    );
  }, [effectivePageSize]);

  const handleSearchChange = useCallback(
    (nextValue: string) => {
      if (serverPagination) {
        setServerSearchState({
          scope: scopeKey,
          syncedExternal: serverPagination.search,
          draft: nextValue,
        });
        if (searchDebounceTimerRef.current) {
          clearTimeout(searchDebounceTimerRef.current);
        }
        searchDebounceTimerRef.current = setTimeout(() => {
          serverPagination.onSearchChange(nextValue);
        }, 250);
      } else {
        setClientRowFilter(nextValue);
        setCurrentPage(1);
        setFocusedCell(null);
      }
    },
    [scopeKey, serverPagination, setCurrentPage]
  );

  const handleClearSearch = useCallback(() => {
    if (serverPagination) {
      if (searchDebounceTimerRef.current) {
        clearTimeout(searchDebounceTimerRef.current);
      }
      setServerSearchState({
        scope: scopeKey,
        syncedExternal: serverPagination.search,
        draft: "",
      });
      serverPagination.onSearchChange("");
    } else {
      setClientRowFilter("");
      setCurrentPage(1);
    }
    setFocusedCell(null);
  }, [scopeKey, serverPagination, setCurrentPage]);

  return (
    <TooltipProvider delay={200}>
      <div className="flex h-full min-h-0 flex-1 flex-col bg-white text-zinc-900">
        {/* Flush Toolbar */}
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <HugeiconsIcon
                icon={GridTableIcon}
                className="size-4 shrink-0 text-zinc-500"
                strokeWidth={1.8}
              />
              <span className="truncate text-sm font-medium tracking-tight text-zinc-900">
                {headerTitle}
              </span>
            </div>

            {result && (
              <span className="shrink-0 text-[13px] text-zinc-600 tabular-nums">
                {result.ok ? (
                  <>
                    {!isServerPaginated && clientRowFilter.trim()
                      ? `${totalRowsCount.toLocaleString()}/${toolbarDisplayCount.toLocaleString()}`
                      : toolbarDisplayCount.toLocaleString()}{" "}
                    {toolbarDisplayCount === 1 ? "row" : "rows"} ·{" "}
                    {result.durationMs} ms
                  </>
                ) : (
                  <span className="text-rose-600">
                    Error · {result.durationMs} ms
                  </span>
                )}
              </span>
            )}

            {(isLoading || isSavingCell || isDeletingRows) && (
              <HugeiconsIcon
                icon={Loading03Icon}
                className="size-3.5 shrink-0 animate-spin text-zinc-500"
              />
            )}

            <InputGroup className="h-8 w-56">
              <InputGroupAddon align="inline-start">
                <HugeiconsIcon icon={Search01Icon} className="size-3.5" />
              </InputGroupAddon>
              <InputGroupInput
                type="text"
                value={searchInputValue}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && serverPagination) {
                    if (searchDebounceTimerRef.current) {
                      clearTimeout(searchDebounceTimerRef.current);
                    }
                    serverPagination.onSearchChange(searchInputValue);
                  }
                }}
                placeholder="Filter..."
                aria-label="Filter grid rows"
                className="h-8 text-[13px]"
              />
              {searchInputValue && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear filter"
                    onClick={handleClearSearch}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {selectedKeySet.size > 0 && canMutateRows && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-7"
                onClick={handleRequestBulkDelete}
                disabled={isDeletingRows}
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="inline-start"
                  strokeWidth={1.8}
                />
                Delete ({selectedKeySet.size})
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              className="h-7 bg-zinc-900 text-white hover:bg-zinc-800"
              onClick={handleOpenAddSheet}
              disabled={!targetTableName || insertSchemaColumns.length === 0}
            >
              <HugeiconsIcon
                icon={PlusSignIcon}
                data-icon="inline-start"
                strokeWidth={2}
              />
              Row
            </Button>

            {resultColumns.length > 0 && (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={SlidersHorizontalIcon}
                    data-icon="inline-start"
                    strokeWidth={1.8}
                  />
                  Cols
                  {hiddenCount > 0 && (
                    <span className="text-[11px] text-zinc-600 tabular-nums">
                      {visibleColumns.length}/{resultColumns.length}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent align="end" className="w-60 p-2.5">
                  <PopoverHeader className="flex-row items-center justify-between gap-2 pb-1">
                    <PopoverTitle className="text-xs font-medium text-zinc-900">
                      Visible columns
                    </PopoverTitle>
                    {hiddenCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => setHiddenColumns(() => ({}))}
                      >
                        Show all
                      </Button>
                    )}
                  </PopoverHeader>
                  <Separator className="my-1" />
                  <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto pt-1">
                    {resultColumns.map((col) => {
                      const isVisible = !hiddenColumns[col.name];
                      return (
                        <label
                          key={col.name}
                          className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-zinc-50"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <Checkbox
                              checked={isVisible}
                              onCheckedChange={() =>
                                handleToggleColumnVisibility(col.name)
                              }
                            />
                            <span className="truncate font-medium text-zinc-800">
                              {col.name}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                            {col.dataType}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={density === "dense" ? "secondary" : "outline"}
                    size="icon-sm"
                    aria-label="Toggle row density"
                    aria-pressed={density === "dense"}
                    onClick={() =>
                      setDensity((d) => (d === "dense" ? "default" : "dense"))
                    }
                  />
                }
              >
                <HugeiconsIcon icon={Rows3Icon} strokeWidth={1.8} />
              </TooltipTrigger>
              <TooltipContent>
                {density === "dense" ? "Default row density" : "Dense rows"}
              </TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={sortedRows.length === 0}
                  />
                }
              >
                <HugeiconsIcon
                  icon={Download01Icon}
                  data-icon="inline-start"
                  strokeWidth={1.8}
                />
                Export
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="inline-end"
                  strokeWidth={1.8}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Export {sortedRows.length} rows</DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleExportCsv}>
                    CSV (.csv)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportJson}>
                    JSON (.json)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      void handleCopyText(
                        formatJsonb(sortedRows),
                        `${sortedRows.length} rows JSON`
                      )
                    }
                  >
                    Copy JSON
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {onOpenSqlTab && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Open in SQL Console"
                      onClick={() =>
                        onOpenSqlTab(
                          activeTable
                            ? buildDefaultSelectSql(activeTable)
                            : undefined
                        )
                      }
                    />
                  }
                >
                  <HugeiconsIcon icon={SqlIcon} strokeWidth={1.8} />
                </TooltipTrigger>
                <TooltipContent>Open in SQL Console</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label="Refresh grid"
                    disabled={isLoading}
                    onClick={onRefresh}
                  />
                }
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  strokeWidth={1.8}
                  className={cn(isLoading && "animate-spin")}
                />
              </TooltipTrigger>
              <TooltipContent>Refresh rows</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Error / Notice Strips */}
        {result && !result.ok && result.error && (
          <div className="flex items-center justify-between gap-2 border-b border-rose-200 bg-rose-50/70 px-3 py-2 text-xs text-rose-800">
            <div className="flex min-w-0 items-start gap-2">
              <HugeiconsIcon
                icon={AlertCircleIcon}
                className="mt-0.5 size-3.5 shrink-0 text-rose-600"
              />
              <span className="font-mono break-all">{result.error}</span>
            </div>
            {onOpenSqlTab && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 bg-white"
                onClick={() =>
                  onOpenSqlTab(
                    activeTable ? buildDefaultSelectSql(activeTable) : undefined
                  )
                }
              >
                Edit SQL
              </Button>
            )}
          </div>
        )}

        {result?.notice && (
          <div className="border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-600">
            {result.notice}
          </div>
        )}

        {/* Edge-to-Edge Spreadsheet Grid (ZERO motion inside table) */}
        <div
          ref={tableContainerRef}
          onScroll={handleGridScroll}
          className="min-h-0 flex-1 overflow-auto bg-white"
        >
          {!result && isLoading ? (
            <div className="flex flex-col divide-y divide-zinc-100">
              <div className="flex h-10 items-center gap-4 border-b border-zinc-200 bg-zinc-50 px-3">
                <div className="size-3.5 rounded bg-zinc-200/80" />
                <div className="h-3.5 w-8 rounded bg-zinc-200/80" />
                <div className="h-3.5 w-32 rounded bg-zinc-200/80" />
                <div className="h-3.5 w-44 rounded bg-zinc-200/80" />
                <div className="h-3.5 w-28 rounded bg-zinc-200/80" />
              </div>
              {Array.from({ length: 10 }).map((_, idx) => (
                <div
                  key={idx}
                  className="flex h-11 items-center gap-4 px-3"
                >
                  <div className="size-3.5 rounded bg-zinc-100" />
                  <div className="h-3.5 w-8 rounded bg-zinc-100" />
                  <div className="h-3.5 w-32 rounded bg-zinc-100" />
                  <div className="h-3.5 w-44 rounded bg-zinc-100" />
                  <div className="h-3.5 w-28 rounded bg-zinc-100" />
                </div>
              ))}
            </div>
          ) : visibleColumns.length > 0 ? (
            <table className="w-full border-separate border-spacing-0 text-left font-sans">
              <thead className="sticky top-0 z-20 bg-zinc-50 text-[13px]">
                <tr className="h-10">
                  <th
                    scope="col"
                    className="sticky left-0 z-30 h-10 w-10 min-w-10 border-r border-b border-zinc-200 bg-zinc-50 px-2.5 text-center select-none"
                  >
                    <div
                      className="flex items-center justify-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={allPageSelected}
                        indeterminate={somePageSelected && !allPageSelected}
                        disabled={pageSelectableKeys.length === 0}
                        onCheckedChange={(checked) =>
                          handleToggleSelectAllPage(Boolean(checked))
                        }
                        aria-label="Select all rows on page"
                        className="data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground"
                      />
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="sticky left-10 z-30 h-10 w-14 min-w-14 border-r border-b border-zinc-200 bg-zinc-50 px-2 text-right font-mono text-xs font-medium text-zinc-500 tabular-nums select-none"
                  >
                    <button
                      type="button"
                      onClick={handleToggleHashOrder}
                      title={
                        sortState?.column === HASH_SORT_KEY &&
                        sortState.direction === "desc"
                          ? "Latest on top (click for 1 on top)"
                          : "1 on top (click for latest on top)"
                      }
                      className="group flex w-full items-center justify-end gap-1 text-right outline-none hover:text-zinc-900 focus-visible:text-zinc-950"
                    >
                      <span>#</span>
                      <HugeiconsIcon
                        icon={
                          sortState?.column === HASH_SORT_KEY &&
                          sortState.direction === "desc"
                            ? ArrowDown01Icon
                            : ArrowUp01Icon
                        }
                        className={cn(
                          "size-3 shrink-0 transition-opacity",
                          sortState?.column === HASH_SORT_KEY &&
                            sortState.direction === "desc"
                            ? "text-zinc-900 opacity-100"
                            : "text-zinc-400 opacity-60 group-hover:opacity-100"
                        )}
                      />
                    </button>
                  </th>
                  {visibleColumns.map((col) => {
                    const isSorted = sortState?.column === col.name;
                    const isPk = primaryKeyColumns.includes(col.name);

                    return (
                      <th
                        key={col.name}
                        scope="col"
                        className="h-10 border-r border-b border-zinc-200 bg-zinc-50 px-3 font-medium whitespace-nowrap text-zinc-900 select-none last:border-r-0"
                      >
                        <button
                          type="button"
                          onClick={() => handleToggleColumnSort(col.name)}
                          title={`Sort by ${col.name}`}
                          className="group flex w-full items-center justify-between gap-2 text-left text-[13px] outline-none focus-visible:text-zinc-950"
                        >
                          <span className="flex items-center gap-1.5">
                            {isPk && (
                              <HugeiconsIcon
                                icon={Key01Icon}
                                className="size-3.5 shrink-0 text-amber-600"
                                strokeWidth={2}
                              />
                            )}
                            <span className="font-medium text-zinc-900">
                              {col.name}
                            </span>
                            <span className="font-mono text-xs font-normal text-zinc-500">
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
                {paginatedRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleColumns.length + 2}
                      className="border-b border-zinc-100 px-4 py-12 text-center text-xs text-zinc-500"
                    >
                      {searchInputValue.trim()
                        ? "No rows match the current filter."
                        : "Table has 0 rows."}
                    </td>
                  </tr>
                ) : (
                  <>
                    {topSpacerHeight > 0 && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={visibleColumns.length + 2}
                          style={{ height: topSpacerHeight, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}
                    {renderedRows.map((row, sliceOffset) => {
                      const rowIndex = virtualStartIndex + sliceOffset;
                      const isHashDesc =
                      sortState?.column === HASH_SORT_KEY &&
                      sortState.direction === "desc";
                    const globalRowNum = isHashDesc
                      ? Math.max(1, totalRowsCount - pageStartIndex - rowIndex)
                      : pageStartIndex + rowIndex + 1;
                    const rowKey = rowKeyByRow.get(row);
                    const isRowSelected = Boolean(
                      rowKey && selectedKeySet.has(rowKey)
                    );
                    const isRowFocused = focusedCell?.rowIndex === rowIndex;
                    const primaryJsonbCol = findPrimaryJsonbColumn(
                      resultColumns,
                      row
                    );

                    const rowTargetColumn =
                      contextTarget && contextTarget.rowIndex === rowIndex
                        ? contextTarget.column
                        : focusedCell && focusedCell.rowIndex === rowIndex
                          ? visibleColumns[focusedCell.colIndex]
                          : visibleColumns[0];

                    const rowTargetColIndex = rowTargetColumn
                      ? visibleColumns.findIndex(
                          (c) => c.name === rowTargetColumn.name
                        )
                      : 0;

                    return (
                      <ContextMenu key={rowKey ?? `row-${globalRowNum}`}>
                        <ContextMenuTrigger
                          render={
                            <tr
                              className={cn(
                                "group/row transition-colors",
                                isRowSelected
                                  ? "bg-zinc-50"
                                  : isRowFocused
                                    ? "bg-zinc-50/60"
                                    : "hover:bg-zinc-50/70"
                              )}
                            />
                          }
                        >
                          <td
                            className={cn(
                              "sticky left-0 z-10 w-10 min-w-10 border-r border-b border-zinc-100 px-2.5 text-center select-none",
                              rowHeightClass,
                              isRowSelected
                                ? "bg-zinc-50"
                                : "bg-white group-hover/row:bg-zinc-50/70"
                            )}
                          >
                            <div
                              className="flex items-center justify-center"
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              <Checkbox
                                checked={isRowSelected}
                                disabled={!rowKey}
                                onCheckedChange={(checked) => {
                                  if (rowKey) {
                                    handleToggleSelectRow(
                                      rowKey,
                                      Boolean(checked)
                                    );
                                  }
                                }}
                                aria-label={`Select row ${globalRowNum}`}
                              />
                            </div>
                          </td>

                          <td
                            className={cn(
                              "sticky left-10 z-10 w-14 min-w-14 border-r border-b border-zinc-100 bg-zinc-50/70 px-2.5 text-right font-mono text-xs text-zinc-500 tabular-nums select-none",
                              rowHeightClass
                            )}
                          >
                            {globalRowNum}
                          </td>

                          {visibleColumns.map((column, colIndex) => {
                            const cellVal = row[column.name] ?? null;
                            const isFocused =
                              focusedCell?.rowIndex === rowIndex &&
                              focusedCell?.colIndex === colIndex;
                            const isEditing =
                              editingCell?.rowIndex === rowIndex &&
                              editingCell?.colIndex === colIndex;
                            const isUuid = isUuidColumnOrValue(
                              column,
                              cellVal
                            );
                            const isJsonb = isJsonbColumnValue(column, cellVal);
                            const isNumeric =
                              typeof cellVal === "number" ||
                              (cellVal !== null &&
                                isNumericDataType(column.dataType));
                            const isStatus = isStatusColumn(column, cellVal);

                            return (
                              <td
                                key={column.name}
                                data-grid-cell={`${rowIndex}:${colIndex}`}
                                tabIndex={0}
                                onClick={() => {
                                  if (!isEditing) {
                                    setFocusedCell({ rowIndex, colIndex });
                                  }
                                }}
                                onDoubleClick={() => {
                                  if (isJsonb) {
                                    openInspector(
                                      row,
                                      resultColumns,
                                      globalRowNum,
                                      column
                                    );
                                  } else if (canInlineEdit) {
                                    beginInlineEdit(
                                      rowIndex,
                                      colIndex,
                                      column,
                                      row
                                    );
                                  }
                                }}
                                onContextMenu={() => {
                                  setFocusedCell({ rowIndex, colIndex });
                                  setContextTarget({
                                    rowIndex,
                                    colIndex,
                                    column,
                                    cellValue: cellVal,
                                    row,
                                  });
                                }}
                                onKeyDown={(e) =>
                                  handleCellKeyDown(
                                    e,
                                    rowIndex,
                                    colIndex,
                                    column,
                                    row
                                  )
                                }
                                title={
                                  cellVal === null
                                    ? "NULL"
                                    : typeof cellVal === "object"
                                      ? JSON.stringify(cellVal)
                                      : String(cellVal)
                                }
                                className={cn(
                                  "relative max-w-xs border-r border-b border-zinc-100 whitespace-nowrap outline-none last:border-r-0",
                                  rowHeightClass,
                                  !isEditing && cellPadClass,
                                  isNumeric && "text-right tabular-nums",
                                  isFocused &&
                                    "bg-zinc-50 ring-2 ring-zinc-900 ring-inset"
                                )}
                              >
                                {isEditing && editingCell ? (
                                  <div
                                    className="flex h-full items-center gap-1 px-1.5"
                                    onClick={(e) => e.stopPropagation()}
                                    onDoubleClick={(e) => e.stopPropagation()}
                                  >
                                    <input
                                      ref={inlineInputRef}
                                      type="text"
                                      value={
                                        editingCell.isNull
                                          ? ""
                                          : editingCell.draft
                                      }
                                      placeholder={
                                        editingCell.isNull ? "NULL" : undefined
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                      onDoubleClick={(e) => e.stopPropagation()}
                                      onChange={(e) =>
                                        setEditingCell((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                draft: e.target.value,
                                                isNull: false,
                                              }
                                            : prev
                                        )
                                      }
                                      onBlur={() => finishInlineEdit("blur")}
                                      onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === "Enter") {
                                          e.preventDefault();
                                          finishInlineEdit("save");
                                        } else if (e.key === "Escape") {
                                          e.preventDefault();
                                          finishInlineEdit("cancel");
                                        } else if (e.key === "Tab") {
                                          e.preventDefault();
                                          finishInlineEdit(
                                            "save",
                                            e.shiftKey ? "prev" : "next"
                                          );
                                        }
                                      }}
                                      className={cn(
                                        "h-7 min-w-[100px] flex-1 rounded bg-white px-2 text-zinc-900 outline-none",
                                        isUuid
                                          ? "font-mono text-[13px]"
                                          : "font-sans text-sm",
                                        editingCell.isNull &&
                                          "italic placeholder:text-zinc-500"
                                      )}
                                    />
                                    {column.nullable && (
                                      <button
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() =>
                                          setEditingCell((prev) =>
                                            prev
                                              ? {
                                                  ...prev,
                                                  isNull: !prev.isNull,
                                                  draft: prev.isNull
                                                    ? prev.draft
                                                    : "",
                                                }
                                              : prev
                                          )
                                        }
                                        className={cn(
                                          "shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium",
                                          editingCell.isNull
                                            ? "border-zinc-900 bg-zinc-900 text-white"
                                            : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:text-zinc-900"
                                        )}
                                      >
                                        NULL
                                      </button>
                                    )}
                                  </div>
                                ) : cellVal === null ? (
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
                                      openInspector(
                                        row,
                                        resultColumns,
                                        globalRowNum,
                                        column
                                      );
                                    }}
                                    className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900"
                                  >
                                    <HugeiconsIcon
                                      icon={BracesIcon}
                                      className="size-3 text-zinc-500"
                                    />
                                    <span>{summarizeJsonValue(cellVal)}</span>
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
                                ) : isUuid ? (
                                  <span className="block truncate font-mono text-xs text-zinc-600">
                                    {String(cellVal)}
                                  </span>
                                ) : column.dataType === "timestamptz" ||
                                  column.dataType === "timestamp" ? (
                                  <span className="font-mono text-xs text-zinc-600 tabular-nums">
                                    {formatUtcTimestamp(String(cellVal))}
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

                        <ContextMenuContent className="w-56">
                          <ContextMenuGroup>
                            <ContextMenuLabel>
                              Row #{globalRowNum}
                              {rowTargetColumn
                                ? ` · ${rowTargetColumn.name}`
                                : ""}
                            </ContextMenuLabel>
                            <ContextMenuSeparator />

                            {canInlineEdit && rowTargetColumn && (
                              <ContextMenuItem
                                onClick={() => {
                                  if (
                                    isJsonbColumnValue(
                                      rowTargetColumn,
                                      row[rowTargetColumn.name] ?? null
                                    )
                                  ) {
                                    openInspector(
                                      row,
                                      resultColumns,
                                      globalRowNum,
                                      rowTargetColumn
                                    );
                                  } else {
                                    beginInlineEdit(
                                      rowIndex,
                                      Math.max(0, rowTargetColIndex),
                                      rowTargetColumn,
                                      row
                                    );
                                  }
                                }}
                              >
                                <HugeiconsIcon
                                  icon={PencilEdit01Icon}
                                  strokeWidth={1.8}
                                />
                                <span>Edit cell</span>
                                <ContextMenuShortcut>↵</ContextMenuShortcut>
                              </ContextMenuItem>
                            )}

                            {rowTargetColumn && (
                              <ContextMenuItem
                                onClick={() =>
                                  void handleCopyText(
                                    stringifyCellForCopy(
                                      row[rowTargetColumn.name] ?? null
                                    ),
                                    rowTargetColumn.name
                                  )
                                }
                              >
                                <HugeiconsIcon
                                  icon={Copy01Icon}
                                  strokeWidth={1.8}
                                />
                                <span>Copy cell</span>
                                <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                              </ContextMenuItem>
                            )}

                            <ContextMenuItem
                              onClick={() =>
                                openInspector(
                                  row,
                                  resultColumns,
                                  globalRowNum,
                                  rowTargetColumn &&
                                    isJsonbColumnValue(
                                      rowTargetColumn,
                                      row[rowTargetColumn.name] ?? null
                                    )
                                    ? rowTargetColumn
                                    : primaryJsonbCol
                                )
                              }
                            >
                              <HugeiconsIcon
                                icon={ViewIcon}
                                strokeWidth={1.8}
                              />
                              <span>Inspect JSONB / Row</span>
                            </ContextMenuItem>

                            <ContextMenuItem
                              onClick={() =>
                                void handleCopyText(
                                  formatJsonb(row),
                                  `Row #${globalRowNum} JSON`
                                )
                              }
                            >
                              <HugeiconsIcon
                                icon={BracesIcon}
                                strokeWidth={1.8}
                              />
                              <span>Copy row JSON</span>
                            </ContextMenuItem>

                            {canMutateRows && (
                              <>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    handleRequestSingleRowDelete(
                                      row,
                                      globalRowNum
                                    )
                                  }
                                >
                                  <HugeiconsIcon
                                    icon={Delete02Icon}
                                    strokeWidth={1.8}
                                  />
                                  <span>Delete row</span>
                                </ContextMenuItem>
                              </>
                            )}
                          </ContextMenuGroup>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                    {bottomSpacerHeight > 0 && (
                      <tr aria-hidden="true">
                        <td
                          colSpan={visibleColumns.length + 2}
                          style={{ height: bottomSpacerHeight, padding: 0, border: 0 }}
                        />
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <HugeiconsIcon
                icon={GridTableIcon}
                className="size-6 text-zinc-500"
                strokeWidth={1.6}
              />
              <p className="text-sm font-medium text-zinc-900">
                {activeTable
                  ? `${activeTable.schema}.${activeTable.name}`
                  : "No table loaded"}
              </p>
              <p className="max-w-sm text-xs text-zinc-500">
                {activeTable
                  ? "Refresh to load rows or open the SQL console to query this relation."
                  : "Select a table from the schema explorer to browse and edit rows."}
              </p>
              {onOpenSqlTab && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7"
                  onClick={() =>
                    onOpenSqlTab(
                      activeTable
                        ? buildDefaultSelectSql(activeTable)
                        : undefined
                    )
                  }
                >
                  <HugeiconsIcon icon={SqlIcon} data-icon="inline-start" />
                  Open SQL Console
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Flush Footer */}
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-zinc-200 bg-white px-3.5 text-[13px] text-zinc-600">
          <div className="flex items-center gap-2 tabular-nums">
            <span>
              Showing {showingFrom}–{showingTo} of{" "}
              {totalRowsCount.toLocaleString()}
            </span>
            {!isServerPaginated &&
              clientRowFilter.trim() &&
              optimisticRows.length !== totalRowsCount && (
                <span className="text-zinc-500">
                  (filtered from {optimisticRows.length.toLocaleString()})
                </span>
              )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Rows</span>
              <Select
                items={pageSizeSelectItems}
                value={String(effectivePageSize)}
                onValueChange={(val) => {
                  if (val) {
                    const nextSize = Number(val);
                    if (serverPagination) {
                      serverPagination.onPageSizeChange(nextSize);
                    } else {
                      setClientPageSize(nextSize);
                      setCurrentPage(1);
                    }
                    setFocusedCell(null);
                  }
                }}
              >
                <SelectTrigger size="sm" className="h-7 w-16 text-xs tabular-nums">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" side="top" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {pageSizeSelectItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="size-7"
                disabled={safePage <= 1 || isLoading}
                onClick={() => {
                  setCurrentPage(Math.max(1, safePage - 1));
                  setFocusedCell(null);
                }}
                aria-label="Previous page"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={1.8} />
              </Button>
              <span className="min-w-12 text-center text-xs text-zinc-600 tabular-nums">
                {safePage}/{totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="size-7"
                disabled={safePage >= totalPages || isLoading}
                onClick={() => {
                  setCurrentPage(Math.min(totalPages, safePage + 1));
                  setFocusedCell(null);
                }}
                aria-label="Next page"
              >
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={1.8} />
              </Button>
            </div>
          </div>
        </div>

        {/* + Row Insert Sheet */}
        <Sheet open={isAddSheetOpen} onOpenChange={setIsAddSheetOpen}>
          <SheetContent side="right" className="w-full sm:max-w-md">
            <SheetHeader className="border-b border-zinc-200">
              <SheetTitle>Insert row</SheetTitle>
              <SheetDescription className="font-mono text-xs">
                {targetTableName}
              </SheetDescription>
            </SheetHeader>

            <form
              onSubmit={handleSubmitInsertRow}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-3">
                {insertError && (
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-xs text-rose-800">
                    {insertError}
                  </div>
                )}

                {insertSchemaColumns.map((col) => {
                  const isPk = primaryKeyColumns.includes(col.name);
                  const draft = insertDrafts[col.name] ?? {
                    mode: "default" as const,
                    value: "",
                  };
                  const isBool = isBooleanDataType(col.dataType);
                  const isJson = isJsonbColumnType(col.dataType);

                  return (
                    <div key={col.name} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {isPk && (
                            <HugeiconsIcon
                              icon={Key01Icon}
                              className="size-3 shrink-0 text-amber-600"
                            />
                          )}
                          <label
                            htmlFor={`insert-col-${col.name}`}
                            className="truncate text-xs font-medium text-zinc-900"
                          >
                            {col.name}
                          </label>
                          <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                            {col.dataType}
                          </span>
                          {!col.nullable && (
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              required
                            </span>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center rounded-md border border-zinc-200 bg-zinc-50 p-0.5 text-[11px]">
                          <button
                            type="button"
                            onClick={() =>
                              setInsertDrafts((prev) => ({
                                ...prev,
                                [col.name]: { ...draft, mode: "value" },
                              }))
                            }
                            className={cn(
                              "rounded px-1.5 py-0.5 font-medium transition-colors",
                              draft.mode === "value"
                                ? "bg-white text-zinc-900 shadow-2xs"
                                : "text-zinc-500 hover:text-zinc-900"
                            )}
                          >
                            Value
                          </button>
                          {col.nullable && (
                            <button
                              type="button"
                              onClick={() =>
                                setInsertDrafts((prev) => ({
                                  ...prev,
                                  [col.name]: { ...draft, mode: "null" },
                                }))
                              }
                              className={cn(
                                "rounded px-1.5 py-0.5 font-medium transition-colors",
                                draft.mode === "null"
                                  ? "bg-white text-zinc-900 shadow-2xs"
                                  : "text-zinc-500 hover:text-zinc-900"
                              )}
                            >
                              NULL
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setInsertDrafts((prev) => ({
                                ...prev,
                                [col.name]: { ...draft, mode: "default" },
                              }))
                            }
                            className={cn(
                              "rounded px-1.5 py-0.5 font-medium transition-colors",
                              draft.mode === "default"
                                ? "bg-white text-zinc-900 shadow-2xs"
                                : "text-zinc-500 hover:text-zinc-900"
                            )}
                          >
                            Default
                          </button>
                        </div>
                      </div>

                      {draft.mode === "default" ? (
                        <div className="flex h-8 items-center rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-2.5 font-mono text-xs text-zinc-500">
                          PostgreSQL DEFAULT
                        </div>
                      ) : draft.mode === "null" ? (
                        <div className="flex h-8 items-center rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-2.5 font-mono text-xs text-zinc-500 italic">
                          NULL
                        </div>
                      ) : isBool ? (
                        <Select
                          items={BOOLEAN_SELECT_ITEMS}
                          value={draft.value === "true" ? "true" : "false"}
                          onValueChange={(val) => {
                            if (val) {
                              setInsertDrafts((prev) => ({
                                ...prev,
                                [col.name]: { mode: "value", value: val },
                              }));
                            }
                          }}
                        >
                          <SelectTrigger
                            id={`insert-col-${col.name}`}
                            className="h-8 w-full font-mono text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              {BOOLEAN_SELECT_ITEMS.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : isJson ? (
                        <Textarea
                          id={`insert-col-${col.name}`}
                          value={draft.value}
                          onChange={(e) =>
                            setInsertDrafts((prev) => ({
                              ...prev,
                              [col.name]: {
                                mode: "value",
                                value: e.target.value,
                              },
                            }))
                          }
                          placeholder='{"key": "value"}'
                          className="min-h-20 font-mono text-xs"
                        />
                      ) : (
                        <Input
                          id={`insert-col-${col.name}`}
                          value={draft.value}
                          onChange={(e) =>
                            setInsertDrafts((prev) => ({
                              ...prev,
                              [col.name]: {
                                mode: "value",
                                value: e.target.value,
                              },
                            }))
                          }
                          placeholder={col.dataType}
                          className="h-8 font-mono text-xs"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <SheetFooter className="border-t border-zinc-200 sm:flex-row sm:justify-end">
                <SheetClose
                  render={
                    <Button type="button" variant="outline" size="sm" />
                  }
                >
                  Cancel
                </SheetClose>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isInsertingRow}
                  className="bg-zinc-900 text-white hover:bg-zinc-800"
                >
                  {isInsertingRow ? "Inserting..." : "Insert Row"}
                </Button>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>

        {/* Delete Confirmation AlertDialog */}
        <AlertDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open && !isDeletingRows) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete rows</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget?.description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-xs text-rose-800">
                {deleteError}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeletingRows}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isDeletingRows}
                onClick={handleConfirmDelete}
              >
                {isDeletingRows ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* JSONB / Row Inspector Dialog */}
        <Dialog
          open={Boolean(inspector)}
          onOpenChange={(open) => {
            if (!open) setInspector(null);
          }}
        >
          <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl">
            <DialogHeader className="gap-1">
              <div className="flex items-center justify-between gap-3 pr-6">
                <DialogTitle>{inspector?.title ?? "Inspector"}</DialogTitle>
                {inspector?.jsonbColumn && (
                  <Tabs
                    value={inspector.activeMode}
                    onValueChange={(nextMode) => {
                      if (nextMode !== "jsonb" && nextMode !== "row") return;
                      setInspector((prev) =>
                        prev ? { ...prev, activeMode: nextMode } : prev
                      );
                      setInspectorJsonDraft(
                        nextMode === "jsonb"
                          ? formatJsonb(inspector.jsonbValue ?? null)
                          : formatJsonb(inspector.rowValue)
                      );
                    }}
                  >
                    <TabsList className="h-7">
                      <TabsTrigger value="jsonb" className="text-xs">
                        {inspector.jsonbColumn}
                      </TabsTrigger>
                      <TabsTrigger value="row" className="text-xs">
                        Full Row
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
              </div>
              <DialogDescription className="text-xs">
                {inspector?.subtitle}
              </DialogDescription>
            </DialogHeader>

            <div className="h-[380px] min-h-0 flex-1 overflow-hidden">
              <JsonbViewer
                value={
                  isInspectorJsonbEditable
                    ? inspectorJsonDraft
                    : activeInspectorPayload
                }
                readOnly={!isInspectorJsonbEditable}
                onChange={
                  isInspectorJsonbEditable ? setInspectorJsonDraft : undefined
                }
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
                    isInspectorJsonbEditable
                      ? inspectorJsonDraft
                      : formatJsonb(activeInspectorPayload),
                    inspector?.title ?? "JSON"
                  )
                }
              >
                <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
                Copy JSON
              </Button>
              {isInspectorJsonbEditable && (
                <Button
                  type="button"
                  size="sm"
                  className="bg-zinc-900 text-white hover:bg-zinc-800"
                  onClick={handleSaveInspectorJsonb}
                  disabled={isSavingCell}
                >
                  Save JSONB
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

export default DataGridView;
