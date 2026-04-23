export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan';

export type Logger = {
  silly?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type ClaudeForChromeContext = Record<string, unknown>;

export const BROWSER_TOOLS: Array<{ name: string }> = [];

export function createClaudeForChromeMcpServer(
  _context: ClaudeForChromeContext,
) {
  return {
    async connect(_transport: unknown): Promise<void> {},
  };
}
