import { query } from '@anthropic-ai/claude-agent-sdk';

/** One entry in the slash-command palette. */
export type SlashCommandEntry = {
  name: string;
  description: string;
  argumentHint?: string;
  /** True for commands this app adds rather than Claude Code's own. */
  local: boolean;
};

/**
 * Commands T.A.I.L.S. adds on top of Claude Code's.
 *
 * These are ordinary prompts with a recognisable name — the model sees the
 * expanded text, not the slash. `/personalize` exists because "change how this
 * app looks" is a capability the user has to be told about; nothing else in
 * the UI advertises that the agent can restyle its own interface.
 */
export const LOCAL_COMMANDS: Record<string, { description: string; argumentHint?: string; expand: (args: string) => string }> = {
  personalize: {
    description: 'Redesign the T.A.I.L.S. interface',
    argumentHint: '<the look you want>',
    expand: (args) => [
      'Redesign the T.A.I.L.S. interface for me.',
      args.trim()
        ? `Here is what I want: ${args.trim()}`
        : 'Ask me what mood or style I want if it is not obvious from our conversation.',
      'Use the tails-appearance tools: list the reference presets first, then preview your design so I can see it, then apply it once I am happy.',
      'Design something of your own rather than picking the closest preset — the presets are only examples of the format.',
    ].join(' '),
  },
};

/**
 * How long a fetched command list is reused.
 *
 * Enumerating commands spawns a CLI subprocess, so it must not happen per
 * keystroke. The set only changes when plugins or skills change, which is rare
 * within a session.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { entries: SlashCommandEntry[]; expiresAt: number } | null = null;

/**
 * Commands the CLI itself only makes sense for in a terminal.
 *
 * Claude Code publishes this set so non-terminal hosts can hide them; showing
 * `/doctor` in a GUI palette is offering something that cannot work here.
 */
const TERMINAL_ONLY = new Set(['doctor', 'color', 'terminal-setup', 'vim']);

/**
 * Lists the slash commands available to the composer.
 *
 * A slash command is not a special protocol — it is sent as ordinary message
 * text and Claude Code interprets it. All this does is discover what exists so
 * the palette can offer it with a description.
 */
export async function listSlashCommands(cwd: string): Promise<SlashCommandEntry[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.entries;

  const local: SlashCommandEntry[] = Object.entries(LOCAL_COMMANDS).map(([name, command]) => ({
    name,
    description: command.description,
    argumentHint: command.argumentHint,
    local: true,
  }));

  let remote: SlashCommandEntry[] = [];
  try {
    // A throwaway query purely to read the command list. `persistSession:false`
    // keeps it from littering the sidebar with an empty conversation.
    const instance = query({
      prompt: '',
      options: { cwd, persistSession: false, env: { ...process.env } as Record<string, string> },
    });

    const commands = await instance.supportedCommands();
    instance.close();

    remote = commands
      .filter((command) => !TERMINAL_ONLY.has(command.name))
      .map((command) => ({
        name: command.name,
        description: command.description ?? '',
        argumentHint: command.argumentHint,
        local: false,
      }));
  } catch {
    // The palette still works with just the local commands; an empty remote
    // list is better than failing the whole composer.
  }

  const entries = [...local, ...remote].sort((left, right) => left.name.localeCompare(right.name));
  cache = { entries, expiresAt: Date.now() + CACHE_TTL_MS };
  return entries;
}

/**
 * Expands a local command into the prompt the model actually receives.
 *
 * Claude Code's own commands are passed through untouched — it interprets them
 * itself, and rewriting them here would break them.
 */
export function expandLocalCommand(content: string): string {
  const match = /^\/([a-z][\w-]*)\s*([\s\S]*)$/i.exec(content.trim());
  if (!match) return content;

  const command = LOCAL_COMMANDS[match[1].toLowerCase()];
  return command ? command.expand(match[2] ?? '') : content;
}
