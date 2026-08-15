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
  /**
   * The expansion is the whole feature, so it is written as a procedure rather
   * than as a wish.
   *
   * The previous version said "list the reference presets first, then preview,
   * then apply" and "design something of your own rather than picking the
   * closest preset" — an instruction immediately after the step that hands over
   * a list of finished looks. Unsurprisingly, what came back was preset-shaped.
   * Three things changed:
   *
   * - `theme_list` now returns the appearance *guide* along with the presets,
   *   so the reading step teaches construction instead of offering a menu. It
   *   is named here as "read the guide", not "list the presets".
   * - Ambiguity gets asked about rather than guessed at, through
   *   `AskUserQuestion`, and — the user's own framing — the two options are a
   *   drastic reading and a conservative one, not two shades of the same idea.
   * - A substantial change is *shown* first, as two live miniatures of the real
   *   app, so the choice is made against something visible. The threshold is
   *   stated here rather than left to taste, because "ask before big changes"
   *   without a definition of big is how a font swap ends up behind a modal.
   */
  personalize: {
    description: 'Redesign the T.A.I.L.S. interface',
    argumentHint: '<the look you want>',
    expand: (args) => [
      'Redesign the T.A.I.L.S. interface for me.',
      args.trim()
        ? `Here is what I want: ${args.trim()}`
        : 'I have not said what I want yet — ask me, with AskUserQuestion, offering concrete directions rather than "what would you like?".',
      'Start by calling mcp__tails-appearance__theme_list and actually reading the guide it returns; it explains how looks are composed here and what the primitives can do. The presets in that response are worked examples to learn from, not options to pick from.',
      'Then judge how big this change is. If it only moves colour, typography, density or corner radius, just build it and preview it — do not make me choose between mockups of a font swap.',
      'If it changes structure — fills, shadows, borders, backdrops, ambient motion, or pinning light/dark — or if what I asked for is open to interpretation, design TWO readings of it: one drastic and one conservative. Show them with mcp__tails-appearance__theme_propose, which renders both as live miniatures of this app, and then ask me which with AskUserQuestion. Do that before applying anything.',
      'Once I have chosen, apply it, and then publish the three or four knobs worth adjusting for that specific look with mcp__tails-appearance__theme_controls so I can tune it without asking you.',
      'Compose the thing I asked for. If some part of it genuinely cannot be built, tell me which primitive is missing rather than giving me the nearest shipped look.',
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
