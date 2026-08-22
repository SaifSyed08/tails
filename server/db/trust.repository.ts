import { getConnection } from '@/db/connection.js';

/** One standing "stop asking me about this" the user granted. */
export type TrustedTool = {
  toolName: string;
  cwd: string;
  createdAt: string;
};

type TrustRow = { tool_name: string; cwd: string; created_at: string };

/**
 * Tools the user has chosen to stop being asked about, and where.
 *
 * The one place this app persists a widening of what the agent may do without
 * asking, which is why every method here is narrow and every one of them is
 * reachable from the settings screen. A grant nobody can see is a grant nobody
 * can take back.
 */
export const trustRepository = {
  isTrusted(toolName: string, cwd: string): boolean {
    const row = getConnection()
      .prepare('SELECT 1 AS ok FROM trusted_tools WHERE tool_name = ? AND cwd = ?')
      .get(toolName, cwd) as { ok: number } | undefined;

    return row !== undefined;
  },

  /** Idempotent: granting twice is one grant, and keeps the original date. */
  grant(toolName: string, cwd: string): void {
    getConnection().prepare(`
      INSERT INTO trusted_tools (tool_name, cwd)
      VALUES (?, ?)
      ON CONFLICT(tool_name, cwd) DO NOTHING
    `).run(toolName, cwd);
  },

  revoke(toolName: string, cwd: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM trusted_tools WHERE tool_name = ? AND cwd = ?')
      .run(toolName, cwd);

    return result.changes > 0;
  },

  revokeAll(): number {
    return getConnection().prepare('DELETE FROM trusted_tools').run().changes;
  },

  /** Newest first: the most recent grant is the one most likely to be regretted. */
  list(): TrustedTool[] {
    const rows = getConnection()
      .prepare('SELECT tool_name, cwd, created_at FROM trusted_tools ORDER BY created_at DESC')
      .all() as TrustRow[];

    return rows.map((row) => ({
      toolName: row.tool_name,
      cwd: row.cwd,
      createdAt: row.created_at,
    }));
  },
};
