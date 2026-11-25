import { io } from "next/cache";
import { getSession } from "@/lib/auth";
import { pingPostgres } from "@/lib/db";
import { getEnvStatus } from "@/lib/env";

export async function GET() {
  await io();

  const session = await getSession();
  const timestamp = new Date().toISOString();

  if (!session) {
    return Response.json(
      {
        ok: true,
        timestamp,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const envStatus = getEnvStatus();
  const envConfigured = envStatus.configured;
  const dbConnected = envConfigured ? (await pingPostgres()).ok : false;

  return Response.json(
    {
      ok: true,
      stack: "pgsa-ultra-lean",
      envConfigured,
      dbConnected,
      timestamp,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
