import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getEnvConfig, getEnvStatus } from "@/lib/env";

export interface PgsaSession {
  username: string;
  issuedAt: number;
  jti: string;
}

const SESSION_COOKIE_NAME = "pgsa_session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

const REVOKED_JTIS_KEY = Symbol.for("pgsa.auth.revokedJtis");
const MAX_REVOKED_JTIS = 5000;

const RATE_LIMIT_KEY = Symbol.for("pgsa.auth.loginRateLimit");
const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_MAX_FAILURES = 5;
const IP_LOCKOUT_STEPS_MS = [30_000, 60_000, 300_000] as const;
const MAX_IP_ENTRIES = 2000;

const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL_COOLDOWN_MS = 60_000;

interface IpRateState {
  failures: number[];
  lockoutLevel: number;
  blockedUntilMs: number;
  lastUpdatedMs: number;
}

interface LoginRateLimitStore {
  ipEntries: Map<string, IpRateState>;
  globalFailures: number[];
  globalBlockedUntilMs: number;
}

const globalForAuth = globalThis as typeof globalThis & {
  [REVOKED_JTIS_KEY]?: Map<string, number>;
  [RATE_LIMIT_KEY]?: LoginRateLimitStore;
};

function getRevokedJtisMap(): Map<string, number> {
  if (!globalForAuth[REVOKED_JTIS_KEY]) {
    globalForAuth[REVOKED_JTIS_KEY] = new Map<string, number>();
  }
  return globalForAuth[REVOKED_JTIS_KEY];
}

function pruneRevokedJtis(map: Map<string, number>, now: number): void {
  for (const [jti, expiresAtMs] of map.entries()) {
    if (expiresAtMs <= now) {
      map.delete(jti);
    }
  }
  while (map.size > MAX_REVOKED_JTIS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function getRateLimitStore(): LoginRateLimitStore {
  if (!globalForAuth[RATE_LIMIT_KEY]) {
    globalForAuth[RATE_LIMIT_KEY] = {
      ipEntries: new Map<string, IpRateState>(),
      globalFailures: [],
      globalBlockedUntilMs: 0,
    };
  }
  return globalForAuth[RATE_LIMIT_KEY];
}

function pruneRateLimitStore(store: LoginRateLimitStore, now: number): void {
  store.globalFailures = store.globalFailures.filter(
    (ts) => now - ts <= GLOBAL_WINDOW_MS
  );
  if (store.globalBlockedUntilMs <= now) {
    store.globalBlockedUntilMs = 0;
  }

  for (const [ip, state] of store.ipEntries.entries()) {
    state.failures = state.failures.filter((ts) => now - ts <= IP_WINDOW_MS);
    if (
      state.blockedUntilMs <= now &&
      state.failures.length === 0 &&
      now - state.lastUpdatedMs > IP_WINDOW_MS
    ) {
      store.ipEntries.delete(ip);
    }
  }

  while (store.ipEntries.size > MAX_IP_ENTRIES) {
    const oldestIp = store.ipEntries.keys().next().value;
    if (oldestIp === undefined) break;
    store.ipEntries.delete(oldestIp);
  }
}

async function getClientIp(): Promise<string> {
  const headerStore = await headers();
  const forwardedFor = headerStore
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  if (forwardedFor) {
    return forwardedFor.slice(0, 128);
  }
  const realIp = headerStore.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp.slice(0, 128);
  }
  return "direct";
}

export async function checkLoginRateLimit(): Promise<
  { allowed: true } | { allowed: false; retryAfterSeconds: number; scope: "ip" | "global" }
> {
  const now = Date.now();
  const store = getRateLimitStore();
  pruneRateLimitStore(store, now);

  if (store.globalBlockedUntilMs > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((store.globalBlockedUntilMs - now) / 1000)
      ),
      scope: "global",
    };
  }

  const ip = await getClientIp();
  const ipState = store.ipEntries.get(ip);
  if (ipState && ipState.blockedUntilMs > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((ipState.blockedUntilMs - now) / 1000)
      ),
      scope: "ip",
    };
  }

  return { allowed: true };
}

export async function recordLoginFailure(): Promise<void> {
  const now = Date.now();
  const store = getRateLimitStore();
  pruneRateLimitStore(store, now);

  store.globalFailures.push(now);
  if (store.globalFailures.length >= GLOBAL_MAX_FAILURES) {
    store.globalBlockedUntilMs = now + GLOBAL_COOLDOWN_MS;
    store.globalFailures = [];
  }

  const ip = await getClientIp();
  const existing = store.ipEntries.get(ip) ?? {
    failures: [],
    lockoutLevel: 0,
    blockedUntilMs: 0,
    lastUpdatedMs: now,
  };

  existing.failures.push(now);
  existing.lastUpdatedMs = now;

  if (existing.failures.length >= IP_MAX_FAILURES) {
    const stepIdx = Math.min(
      existing.lockoutLevel,
      IP_LOCKOUT_STEPS_MS.length - 1
    );
    existing.blockedUntilMs = now + IP_LOCKOUT_STEPS_MS[stepIdx];
    existing.lockoutLevel = Math.min(
      existing.lockoutLevel + 1,
      IP_LOCKOUT_STEPS_MS.length - 1
    );
    existing.failures = [];
  }

  store.ipEntries.delete(ip);
  store.ipEntries.set(ip, existing);
  pruneRateLimitStore(store, now);
}

export async function clearLoginFailures(): Promise<void> {
  const ip = await getClientIp();
  const store = getRateLimitStore();
  store.ipEntries.delete(ip);
}

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqualStrings(left: string, right: string): boolean {
  return timingSafeEqual(sha256Digest(left), sha256Digest(right));
}

function deriveSigningKey(): Buffer {
  const { databaseUrl, username, password } = getEnvConfig();
  return createHash("sha256")
    .update("pgsa:session:v1:")
    .update(databaseUrl)
    .update("\0")
    .update(username)
    .update("\0")
    .update(password)
    .digest();
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", deriveSigningKey())
    .update(encodedPayload)
    .digest("base64url");
}

function verifyToken(token: string): PgsaSession | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex !== token.lastIndexOf(".")) {
    return null;
  }

  const encodedPayload = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);
  if (!encodedPayload || !providedSig) {
    return null;
  }

  let expectedSigBuf: Buffer;
  let providedSigBuf: Buffer;
  try {
    expectedSigBuf = createHmac("sha256", deriveSigningKey())
      .update(encodedPayload)
      .digest();
    providedSigBuf = Buffer.from(providedSig, "base64url");
  } catch {
    return null;
  }

  if (expectedSigBuf.length !== providedSigBuf.length) {
    return null;
  }

  if (!timingSafeEqual(expectedSigBuf, providedSigBuf)) {
    return null;
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Partial<PgsaSession>;
  if (
    typeof candidate.username !== "string" ||
    candidate.username.length === 0 ||
    typeof candidate.issuedAt !== "number" ||
    !Number.isFinite(candidate.issuedAt) ||
    typeof candidate.jti !== "string" ||
    candidate.jti.length === 0
  ) {
    return null;
  }

  const now = Date.now();
  if (
    candidate.issuedAt > now + FUTURE_CLOCK_SKEW_MS ||
    now - candidate.issuedAt > SESSION_MAX_AGE_MS
  ) {
    return null;
  }

  const revoked = getRevokedJtisMap();
  pruneRevokedJtis(revoked, now);
  if (revoked.has(candidate.jti)) {
    return null;
  }

  const { username: configuredUsername } = getEnvConfig();
  if (!safeEqualStrings(candidate.username, configuredUsername)) {
    return null;
  }

  return {
    username: candidate.username,
    issuedAt: candidate.issuedAt,
    jti: candidate.jti,
  };
}

function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[")) {
    return host === "[::1]" || host.startsWith("[::1]:");
  }
  const hostname = host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function shouldUseSecureCookie(): Promise<boolean> {
  if (process.env.PGSA_SECURE_COOKIES === "true") {
    return true;
  }
  if (process.env.PGSA_SECURE_COOKIES === "false") {
    return false;
  }

  const headerStore = await headers();
  const hostHeader =
    headerStore.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    headerStore.get("host")?.trim() ||
    "";

  if (!hostHeader || isLoopbackHost(hostHeader)) {
    return false;
  }

  const forwardedProto = headerStore
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();

  return forwardedProto === "https";
}

export async function getSession(): Promise<PgsaSession | null> {
  if (!getEnvStatus().configured) {
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  return verifyToken(token);
}

export async function requireSession(): Promise<PgsaSession> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export async function verifyCredentials(
  username: string,
  password: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const status = getEnvStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${status.missing.join(", ")}.`,
    };
  }

  const config = getEnvConfig();
  const usernameValid = safeEqualStrings(username.trim(), config.username);
  const passwordValid = safeEqualStrings(password, config.password);

  if (!usernameValid || !passwordValid) {
    return {
      ok: false,
      error: "Invalid username or password.",
    };
  }

  return { ok: true };
}

export async function createSessionCookie(username: string): Promise<void> {
  const session: PgsaSession = {
    username: username.trim(),
    issuedAt: Date.now(),
    jti: randomUUID(),
  };

  const encodedPayload = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  );
  const signature = signPayload(encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: await shouldUseSecureCookie(),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (token && getEnvStatus().configured) {
    const active = verifyToken(token);
    if (active) {
      const now = Date.now();
      const revoked = getRevokedJtisMap();
      revoked.set(active.jti, active.issuedAt + SESSION_MAX_AGE_MS);
      pruneRevokedJtis(revoked, now);
    }
  }

  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: await shouldUseSecureCookie(),
    path: "/",
    maxAge: 0,
  });
}
