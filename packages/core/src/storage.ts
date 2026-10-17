/**
 * Values that can cross a shell boundary as JSON.
 * Binary columns stay in SQLite. Callers store bytes on disk and keep hashes as text.
 */
export type SqlValue = null | string | number;

/**
 * One SQLite session. Statements use `?` placeholders in order.
 * Implementations must not log statement text or bound parameters.
 */
export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<void>;
  select<Row>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
}
