export type PgsaEnvVarName =
  | "DATABASE_URL"
  | "PGSA_USERNAME"
  | "PGSA_PASSWORD";

export interface PgsaEnvConfig {
  databaseUrl: string;
  username: string;
  password: string;
}

export interface PgsaEnvStatus {
  configured: boolean;
  missing: Array<"DATABASE_URL" | "PGSA_USERNAME" | "PGSA_PASSWORD">;
}

const REQUIRED_ENV_KEYS: ReadonlyArray<PgsaEnvVarName> = [
  "DATABASE_URL",
  "PGSA_USERNAME",
  "PGSA_PASSWORD",
];

function readEnvValue(key: PgsaEnvVarName): string {
  const raw = process.env[key];
  if (typeof raw !== "string") {
    return "";
  }
  return raw;
}

export function getEnvStatus(): PgsaEnvStatus {
  const missing: Array<"DATABASE_URL" | "PGSA_USERNAME" | "PGSA_PASSWORD"> = [];

  for (const key of REQUIRED_ENV_KEYS) {
    if (readEnvValue(key).trim().length === 0) {
      missing.push(key);
    }
  }

  return {
    configured: missing.length === 0,
    missing,
  };
}

export function getEnvConfig(): PgsaEnvConfig {
  const status = getEnvStatus();
  if (!status.configured) {
    throw new Error(
      `Configuration Error: Missing required environment variable(s): ${status.missing.join(", ")}. Set them in .env before running PGSA.`
    );
  }

  return {
    databaseUrl: readEnvValue("DATABASE_URL").trim(),
    username: readEnvValue("PGSA_USERNAME").trim(),
    password: readEnvValue("PGSA_PASSWORD"),
  };
}
