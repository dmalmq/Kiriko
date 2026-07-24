export interface AppConfig {
  dataDir: string;
  sessionTtlDays: number;
  secureCookies: boolean;
  issueSseMaxConnections: number;
  jobShutdownGraceMs?: number;
  issueSseMaxPerVersion: number;
  bootstrapUser?: string;
  bootstrapPassword?: string;
  seedDevUsers?: boolean;
}

export function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function configFromEnv(): AppConfig & { port: number } {
  const config: AppConfig & { port: number } = {
    dataDir: process.env["KIRIKO_DATA_DIR"] ?? "./data",
    sessionTtlDays: 30,
    secureCookies: /^(1|true)$/i.test(process.env["KIRIKO_SECURE_COOKIES"] ?? ""),
    issueSseMaxConnections: positiveInt(process.env["KIRIKO_ISSUE_SSE_MAX_CONNECTIONS"], 512),
    issueSseMaxPerVersion: positiveInt(process.env["KIRIKO_ISSUE_SSE_MAX_PER_VERSION"], 128),
    jobShutdownGraceMs: positiveInt(process.env["KIRIKO_JOB_SHUTDOWN_GRACE_MS"], 5_000),
    seedDevUsers: process.env["KIRIKO_SEED_DEV_USERS"] === "1",
    port: Number(process.env["KIRIKO_PORT"] ?? 8790),
  };
  const user = process.env["KIRIKO_BOOTSTRAP_USER"];
  const password = process.env["KIRIKO_BOOTSTRAP_PASSWORD"];
  if (user !== undefined && password !== undefined) {
    config.bootstrapUser = user;
    config.bootstrapPassword = password;
  }
  return config;
}
