"use client";

import { useActionState, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  Database02Icon,
  Loading03Icon,
  LockPasswordIcon,
  Shield01Icon,
  UserIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { loginAction } from "@/app/actions";

export interface LoginFormProps {
  envStatus: {
    configured: boolean;
    missing: string[];
  };
}

const INITIAL_ACTION_STATE: { ok: boolean; error?: string } = { ok: true };

export function LoginForm({ envStatus }: LoginFormProps) {
  const [state, formAction, isPending] = useActionState(
    loginAction,
    INITIAL_ACTION_STATE
  );
  const [showPassword, setShowPassword] = useState(false);

  const isDisabled = isPending || !envStatus.configured;

  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-zinc-50 px-4 py-12 text-zinc-950">
      <div className="w-full max-w-[400px]">
        <div className="rounded-lg border border-zinc-200 bg-white shadow-xs">
          <div className="border-b border-zinc-200 px-6 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-900">
                  <HugeiconsIcon
                    icon={Database02Icon}
                    strokeWidth={1.8}
                    className="size-4"
                  />
                </div>
                <div>
                  <h1 className="text-sm font-semibold tracking-tight text-zinc-950">
                    PGSA Studio
                  </h1>
                  <p className="text-xs text-zinc-600">PostgreSQL Admin</p>
                </div>
              </div>

              {envStatus.configured ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-600">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-emerald-500"
                  />
                  Env Ready
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-amber-500"
                  />
                  Setup Required
                </span>
              )}
            </div>
          </div>

          <div className="space-y-4 p-6">
            {!envStatus.configured && (
              <div
                role="alert"
                className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-950"
              >
                <div className="flex items-start gap-2.5">
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-4 shrink-0 text-amber-600"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-medium text-amber-950">
                      Missing environment variables
                    </p>
                    <p className="text-amber-900/90">
                      Set these keys in{" "}
                      <code className="rounded border border-amber-200 bg-white px-1 py-0.5 font-mono text-[11px] text-amber-950">
                        .env
                      </code>{" "}
                      and restart the server:
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {envStatus.missing.map((key) => (
                        <li
                          key={key}
                          className="rounded border border-amber-200 bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-red-700"
                        >
                          {key}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {!state.ok && state.error && (
              <div
                role="alert"
                aria-live="polite"
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/70 px-3 py-2.5 text-xs text-red-700"
              >
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  strokeWidth={2}
                  className="mt-0.5 size-3.5 shrink-0 text-red-600"
                />
                <span className="leading-relaxed font-medium">
                  {state.error}
                </span>
              </div>
            )}

            <form action={formAction} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="username"
                  className="block text-xs font-medium text-zinc-700"
                >
                  Username
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-600">
                    <HugeiconsIcon
                      icon={UserIcon}
                      strokeWidth={1.8}
                      className="size-4"
                    />
                  </span>
                  <input
                    id="username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    disabled={isPending}
                    placeholder="PGSA_USERNAME"
                    className="h-9 w-full rounded-md border border-zinc-200 bg-white pr-3 pl-9 text-sm text-zinc-950 placeholder:text-zinc-500 transition-colors focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200/70 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-600"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="password"
                  className="block text-xs font-medium text-zinc-700"
                >
                  Password
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-600">
                    <HugeiconsIcon
                      icon={LockPasswordIcon}
                      strokeWidth={1.8}
                      className="size-4"
                    />
                  </span>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    disabled={isPending}
                    placeholder="PGSA_PASSWORD"
                    className="h-9 w-full rounded-md border border-zinc-200 bg-white pr-10 pl-9 text-sm text-zinc-950 placeholder:text-zinc-500 transition-colors focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200/70 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    className="absolute inset-y-1 right-1 inline-flex w-7 items-center justify-center rounded text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:outline-none"
                  >
                    <HugeiconsIcon
                      icon={showPassword ? ViewOffSlashIcon : ViewIcon}
                      strokeWidth={1.8}
                      className="size-4"
                    />
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isDisabled}
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white shadow-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-600 disabled:shadow-none"
              >
                {isPending ? (
                  <>
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      strokeWidth={2}
                      className="size-4 animate-spin"
                    />
                    <span>Signing in…</span>
                  </>
                ) : (
                  <>
                    <span>Sign in</span>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      className="size-4"
                    />
                  </>
                )}
              </button>
            </form>
          </div>

          <div className="flex items-center justify-between rounded-b-lg border-t border-zinc-200 bg-zinc-50 px-6 py-2.5 text-[11px] text-zinc-600">
            <span className="inline-flex items-center gap-1.5">
              <HugeiconsIcon
                icon={Shield01Icon}
                strokeWidth={1.8}
                className="size-3.5 text-zinc-600"
              />
              HttpOnly session
            </span>
            <span className="font-mono text-zinc-600">PostgreSQL</span>
          </div>
        </div>
      </div>
    </main>
  );
}
