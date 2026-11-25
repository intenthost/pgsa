"use server";

import { redirect } from "next/navigation";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clearSessionCookie,
  createSessionCookie,
  recordLoginFailure,
  requireSession,
  verifyCredentials,
} from "@/lib/auth";
import {
  browseTableRows,
  deletePostgresRows,
  executePostgresQuery,
  fetchActivityAndStats,
  fetchSchemaGraph,
  generatePostgresBackup,
  insertPostgresRow,
  restorePostgresSql,
  signalPostgresBackend,
  updatePostgresCell,
} from "@/lib/db";
import type {
  ActivityAndStatsPayload,
  BackupOptions,
  BackupResult,
  BrowseTableInput,
  PostgresRow,
  PostgresValue,
  QueryExecutionResult,
  RestoreResult,
  SchemaGraphResult,
} from "@/types/postgres";

const MAX_SQL_LENGTH = 100_000;
const MAX_RESTORE_SQL_LENGTH = 10_000_000;

export interface LoginActionState {
  ok: boolean;
  error?: string;
}

export async function loginAction(
  prevState: LoginActionState,
  formData: FormData
): Promise<LoginActionState> {
  void prevState;

  const rateLimit = await checkLoginRateLimit();
  if (!rateLimit.allowed) {
    return {
      ok: false,
      error: `Too many failed login attempts. Try again in ${rateLimit.retryAfterSeconds}s.`,
    };
  }

  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    await recordLoginFailure();
    return {
      ok: false,
      error: "Username and password are required.",
    };
  }

  const verification = await verifyCredentials(username, password);
  if (!verification.ok) {
    await recordLoginFailure();
    return {
      ok: false,
      error: verification.error,
    };
  }

  await clearLoginFailures();
  await createSessionCookie(username);
  redirect("/");
}

export async function logoutAction(): Promise<never> {
  await clearSessionCookie();
  redirect("/login");
}

export async function runSqlQueryAction(
  sql: string
): Promise<QueryExecutionResult> {
  await requireSession();

  if (typeof sql !== "string") {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "ERROR",
      error: "SQL query must be a string.",
    };
  }

  if (sql.length > MAX_SQL_LENGTH) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
      command: "ERROR",
      error: `Query exceeds maximum length of ${MAX_SQL_LENGTH.toLocaleString()} characters.`,
    };
  }

  return executePostgresQuery(sql);
}

export async function browseTableAction(
  input: BrowseTableInput
): Promise<QueryExecutionResult> {
  await requireSession();
  return browseTableRows(input);
}

export async function updateTableCellAction(input: {
  table: string;
  primaryKey: Record<string, PostgresValue>;
  column: string;
  value: PostgresValue;
}): Promise<{ ok: boolean; error?: string; value?: PostgresValue }> {
  await requireSession();
  return updatePostgresCell(input);
}

export async function insertTableRowAction(input: {
  table: string;
  values: Record<string, PostgresValue | undefined>;
}): Promise<{ ok: boolean; row?: PostgresRow; error?: string }> {
  await requireSession();
  return insertPostgresRow(input);
}

export async function deleteTableRowsAction(input: {
  table: string;
  primaryKeys: Array<Record<string, PostgresValue>>;
}): Promise<{ ok: boolean; deletedCount: number; error?: string }> {
  await requireSession();
  return deletePostgresRows(input);
}

export async function getSchemaGraphAction(): Promise<SchemaGraphResult> {
  await requireSession();
  return fetchSchemaGraph();
}

export async function generateBackupAction(
  options: BackupOptions
): Promise<BackupResult> {
  await requireSession();
  return generatePostgresBackup(options);
}

export async function restoreSqlAction(input: {
  sql: string;
  singleTransaction: boolean;
}): Promise<RestoreResult> {
  await requireSession();

  if (typeof input?.sql !== "string") {
    return {
      ok: false,
      statementsExecuted: 0,
      durationMs: 0,
      error: "Restore SQL must be a string.",
    };
  }

  if (input.sql.length > MAX_RESTORE_SQL_LENGTH) {
    return {
      ok: false,
      statementsExecuted: 0,
      durationMs: 0,
      error: `Restore SQL exceeds maximum length of ${MAX_RESTORE_SQL_LENGTH.toLocaleString()} characters.`,
    };
  }

  return restorePostgresSql({
    sql: input.sql,
    singleTransaction: Boolean(input.singleTransaction),
  });
}

export async function getActivityStatsAction(): Promise<ActivityAndStatsPayload> {
  await requireSession();
  return fetchActivityAndStats();
}

export async function signalBackendPidAction(input: {
  pid: number;
  mode: "cancel" | "terminate";
}): Promise<{ ok: boolean; signalled?: boolean; error?: string }> {
  await requireSession();
  return signalPostgresBackend(input);
}
