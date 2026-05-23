import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export function sqlLiteral(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export async function sqliteJson<T>(
  config: AppConfig,
  dbPath: string,
  sql: string,
  timeout = 20_000,
): Promise<T[]> {
  const { stdout } = await execFileAsync(config.SQLITE3_BIN, ["-readonly", "-json", dbPath, sql], {
    maxBuffer: 100 * 1024 * 1024,
    timeout,
  });

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  return JSON.parse(trimmed) as T[];
}

export async function sqliteOne<T>(
  config: AppConfig,
  dbPath: string,
  sql: string,
  timeout = 20_000,
): Promise<T | null> {
  const rows = await sqliteJson<T>(config, dbPath, sql, timeout);
  return rows[0] ?? null;
}
