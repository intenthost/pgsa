import type { Metadata } from "next";
import { Suspense } from "react";
import { io } from "next/cache";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getSession } from "@/lib/auth";
import { getEnvStatus } from "@/lib/env";

export const metadata: Metadata = {
  title: "Sign In — PGSA",
  description: "Sign in to PGSA PostgreSQL administration workspace",
};

function LoginFallback() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-zinc-50 px-4 py-12">
      <div className="w-full max-w-[400px] rounded-lg border border-zinc-200 bg-white p-6 shadow-xs">
        <div className="mb-6 flex items-center gap-3">
          <div className="size-9 animate-pulse rounded-md bg-zinc-100" />
          <div className="space-y-1.5">
            <div className="h-4 w-24 animate-pulse rounded bg-zinc-100" />
            <div className="h-3 w-36 animate-pulse rounded bg-zinc-100" />
          </div>
        </div>
        <div className="space-y-4">
          <div className="h-9 animate-pulse rounded-md bg-zinc-100" />
          <div className="h-9 animate-pulse rounded-md bg-zinc-100" />
          <div className="h-9 animate-pulse rounded-md bg-zinc-200" />
        </div>
      </div>
    </main>
  );
}

async function LoginGate() {
  await io();

  const session = await getSession();
  if (session) {
    redirect("/");
  }

  const envStatus = getEnvStatus();

  return (
    <LoginForm
      envStatus={{
        configured: envStatus.configured,
        missing: [...envStatus.missing],
      }}
    />
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginGate />
    </Suspense>
  );
}
