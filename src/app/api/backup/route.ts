import { io } from "next/cache";
import { getSession } from "@/lib/auth";
import { generatePostgresBackup } from "@/lib/db";
import type { BackupOptions } from "@/types/postgres";

function buildJsonErrorResponse(error: string, status: number) {
  return Response.json(
    { ok: false, error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

function verifySameOriginPost(request: Request): string | null {
  const secFetchSite = request.headers
    .get("sec-fetch-site")
    ?.trim()
    .toLowerCase();
  if (secFetchSite === "cross-site") {
    return "Forbidden: cross-site request rejected.";
  }

  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "Forbidden: invalid origin header.";
    }

    const expectedHost = (
      request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      request.headers.get("host")?.trim() ||
      ""
    ).toLowerCase();

    if (!expectedHost || originHost !== expectedHost) {
      return "Forbidden: origin mismatch.";
    }
  }

  return null;
}

function buildBackupHttpResponse(
  options: BackupOptions,
  backup: Awaited<ReturnType<typeof generatePostgresBackup>>
) {
  if (!backup.ok) {
    return buildJsonErrorResponse(
      backup.error ?? "Backup generation failed.",
      400
    );
  }

  const safeFilename = backup.filename.replace(/["\\\r\n]/g, "");
  const contentType =
    options.format === "json"
      ? "application/json; charset=utf-8"
      : "application/sql; charset=utf-8";

  return new Response(backup.content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-store",
      "X-PGSA-Row-Count": String(backup.rowCount),
      "X-PGSA-Statement-Count": String(backup.statementCount),
    },
  });
}

export async function POST(request: Request) {
  await io();

  const csrfError = verifySameOriginPost(request);
  if (csrfError) {
    return buildJsonErrorResponse(csrfError, 403);
  }

  const session = await getSession();
  if (!session) {
    return buildJsonErrorResponse("Unauthorized", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return buildJsonErrorResponse("Invalid JSON request body.", 400);
  }

  if (!body || typeof body !== "object") {
    return buildJsonErrorResponse("Request body must be a JSON object.", 400);
  }

  const raw = body as Partial<BackupOptions>;
  const options: BackupOptions = {
    tables: Array.isArray(raw.tables)
      ? raw.tables
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    includeSchema: raw.includeSchema !== false,
    includeData: raw.includeData !== false,
    format: raw.format === "json" ? "json" : "sql",
  };

  const backup = await generatePostgresBackup(options);
  return buildBackupHttpResponse(options, backup);
}
