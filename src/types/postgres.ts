export type PostgresScalar = string | number | boolean | null;

export type PostgresJsonObject = {
  [key: string]: PostgresJsonValue;
};

export type PostgresJsonValue =
  | PostgresScalar
  | PostgresJsonObject
  | PostgresJsonValue[];

export type PostgresValue = PostgresJsonValue;

export type PostgresDataType =
  | "uuid"
  | "text"
  | "varchar"
  | "bpchar"
  | "char"
  | "int2"
  | "int4"
  | "int8"
  | "float4"
  | "float8"
  | "numeric"
  | "bool"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "timetz"
  | "interval"
  | "inet"
  | "cidr"
  | "macaddr"
  | "bytea"
  | "oid"
  | "json"
  | "jsonb"
  | "text[]"
  | "varchar[]"
  | "int4[]"
  | "int8[]"
  | "uuid[]"
  | "jsonb[]"
  | (string & {});

export interface PostgresColumn {
  name: string;
  dataType: PostgresDataType;
  oid: number;
  nullable: boolean;
}

export type PostgresRow = Record<string, PostgresValue>;

export interface TableSchema {
  schema: string;
  name: string;
  rowEstimate: number;
  primaryKeyColumns: string[];
  columns: PostgresColumn[];
}

export type SqlCommandTag =
  | "SELECT"
  | "EXPLAIN"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "SHOW"
  | "SET"
  | "CREATE"
  | "ALTER"
  | "DROP"
  | "TRUNCATE"
  | "EMPTY"
  | "ERROR"
  | (string & {});

export interface QueryExecutionResult {
  ok: boolean;
  columns: PostgresColumn[];
  rows: PostgresRow[];
  rowCount: number;
  totalRows?: number;
  page?: number;
  pageSize?: number;
  durationMs: number;
  command: SqlCommandTag;
  sourceTable?: string;
  primaryKeyColumns?: string[];
  editable?: boolean;
  notice?: string;
  error?: string;
}

export interface BrowseTableInput {
  schema: string;
  table: string;
  page?: number;
  pageSize?: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  search?: string;
}

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  isDirty: boolean;
}

export interface RowStatusToggleResult {
  ok: boolean;
  id: string;
  status: string;
}

export interface TableColumnDetail {
  name: string;
  dataType: PostgresDataType;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue?: string;
  foreignTarget?: {
    schema: string;
    table: string;
    column: string;
  };
}

export interface TableNode {
  schema: string;
  name: string;
  rowEstimate: number;
  primaryKeyColumns: string[];
  columns: TableColumnDetail[];
}

export interface ForeignKeyEdge {
  constraintName: string;
  sourceSchema: string;
  sourceTable: string;
  sourceColumns: string[];
  targetSchema: string;
  targetTable: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface SchemaGraph {
  tables: TableNode[];
  edges: ForeignKeyEdge[];
  schemas: string[];
}

export interface SchemaGraphResult {
  ok: boolean;
  graph: SchemaGraph;
  error?: string;
}

export interface BackupOptions {
  tables: string[];
  includeSchema: boolean;
  includeData: boolean;
  format: "sql" | "json";
}

export interface BackupResult {
  ok: boolean;
  filename: string;
  content: string;
  statementCount: number;
  rowCount: number;
  sizeBytes: number;
  error?: string;
}

export interface RestoreResult {
  ok: boolean;
  statementsExecuted: number;
  durationMs: number;
  error?: string;
  failedStatement?: string;
}

export interface ActivityProcess {
  pid: number;
  usename: string | null;
  datname: string | null;
  applicationName: string;
  clientAddr: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string;
  durationMs: number | null;
  backendStart: string | null;
  queryStart: string | null;
  isCurrentBackend: boolean;
}

export interface TableStorageStat {
  schema: string;
  name: string;
  rowEstimate: number;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  seqScan: number;
  idxScan: number;
  nDeadTup: number;
}

export interface PgRoleInfo {
  rolname: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolcanlogin: boolean;
  rolconnlimit: number;
}

export interface PgExtensionInfo {
  name: string;
  version: string;
  schema: string;
}

export interface ActivityAndStatsPayload {
  ok: boolean;
  currentPid: number;
  databaseName: string;
  databaseSizeBytes: number;
  activities: ActivityProcess[];
  tableStats: TableStorageStat[];
  roles: PgRoleInfo[];
  extensions: PgExtensionInfo[];
  error?: string;
}
