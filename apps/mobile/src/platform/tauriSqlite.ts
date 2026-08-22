/**
 * SqlExecutor over the in-crate `sql_*` Tauri commands (CDX-012).
 *
 * Until Phase 6 this seam rode tauri-plugin-sql; that plugin's sqlx pins
 * libsqlite3-sys 0.28 while MDK (Marmot) needs rusqlite/libsqlite3-sys 0.35,
 * and cargo forbids two linked sqlite3 copies in one binary — so the plugin
 * was replaced by three thin commands over the SAME rusqlite build MDK uses
 * (src-tauri/src/sqlstore.rs). Contract unchanged: single statements, `?`
 * positional params, rows as column-name→value objects; same DB file
 * (app-config-dir/codedeck.db), so existing installs keep their data.
 *
 * Kept in its own module so `sqlite.ts` (and its node-side tests) never
 * import Tauri — this file is only reached from the Tauri boot path.
 */
import type { SqlExecutor } from './sqlite';

export async function openTauriDatabase(): Promise<SqlExecutor> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('sql_open');
  return {
    execute: async (sql, params = []) => {
      await invoke('sql_execute', { sql, params });
    },
    select: async <T>(sql: string, params: unknown[] = []) =>
      (await invoke('sql_select', { sql, params })) as T[],
  };
}
