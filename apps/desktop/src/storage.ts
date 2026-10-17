import { invoke } from "@tauri-apps/api/core";
import { MIGRATIONS, migrate, type SqlExecutor, type SqlValue } from "@shakespeare/core";

function createExecutor(): SqlExecutor {
  return {
    async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
      await invoke("db_execute", { sql, params: [...params] });
    },
    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return invoke<Row[]>("db_select", { sql, params: [...params] });
    },
  };
}

/** Opens the shell database and applies pending migrations. `now` is the caller's clock. */
export async function openLocalDatabase(now: string): Promise<number> {
  return migrate(createExecutor(), MIGRATIONS, { now });
}
