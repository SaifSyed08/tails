/**
 * Per-tool display configuration.
 *
 * Adding a tool means adding one object here, not editing a renderer. The
 * renderer stays a dumb router, which is what keeps it from accreting a branch
 * per tool the way these views usually do.
 */
export type ToolDisplay = {
  /** Human label shown on the row. */
  label: string;
  /** Pulls the one-line summary out of the tool's input. */
  summarize?: (input: Record<string, unknown>) => string | undefined;
  /** How the result body should be rendered when expanded. */
  resultFormat?: 'text' | 'code' | 'diff';
  /** Collapsed by default unless the user expands it. */
  collapsed?: boolean;
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Shortens an absolute path to something readable in a one-line row. */
const shortenPath = (value: unknown): string | undefined => {
  const path = readString(value);
  if (!path) return undefined;
  const parts = path.split(/[\\/]/);
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`;
};

export const TOOL_DISPLAYS: Record<string, ToolDisplay> = {
  Bash: {
    label: 'Terminal',
    summarize: (input) => readString(input.command),
    resultFormat: 'code',
    collapsed: true,
  },
  Read: {
    label: 'Read',
    summarize: (input) => shortenPath(input.file_path),
    resultFormat: 'code',
    collapsed: true,
  },
  Write: {
    label: 'Write',
    summarize: (input) => shortenPath(input.file_path),
    resultFormat: 'text',
    collapsed: true,
  },
  Edit: {
    label: 'Edit',
    summarize: (input) => shortenPath(input.file_path),
    resultFormat: 'diff',
    collapsed: true,
  },
  Glob: {
    label: 'Find files',
    summarize: (input) => readString(input.pattern),
    resultFormat: 'text',
    collapsed: true,
  },
  Grep: {
    label: 'Search',
    summarize: (input) => readString(input.pattern),
    resultFormat: 'text',
    collapsed: true,
  },
  WebFetch: {
    label: 'Fetch',
    summarize: (input) => readString(input.url),
    resultFormat: 'text',
    collapsed: true,
  },
  WebSearch: {
    label: 'Web search',
    summarize: (input) => readString(input.query),
    resultFormat: 'text',
    collapsed: true,
  },
  TodoWrite: {
    label: 'Plan',
    summarize: () => 'Updated the task list',
    resultFormat: 'text',
    collapsed: true,
  },
  Task: {
    label: 'Subagent',
    summarize: (input) => readString(input.description),
    resultFormat: 'text',
    collapsed: true,
  },
};

/**
 * The display for a tool, with a usable default.
 *
 * Unknown tools render generically rather than being hidden — the SDK ships
 * new tools regularly, and a silently invisible tool call is worse than a
 * plain one.
 */
export function readToolDisplay(toolName: string): ToolDisplay {
  return TOOL_DISPLAYS[toolName] ?? { label: toolName, resultFormat: 'text', collapsed: true };
}
