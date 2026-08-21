import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { appBroadcast } from '@/shared/broadcast.js';
import { createMessage } from '@/shared/utils.js';

/**
 * Letting the agent show the thing it just built.
 *
 * A coding assistant that starts a dev server and then says "it's running on
 * port 5173" has finished half a job. The user has to leave the app, find a
 * browser, type a URL, and hold the two windows side by side themselves — and
 * every iteration after that repeats it. This closes the loop: the agent starts
 * the server, opens the preview, and the result is next to the conversation
 * that produced it.
 *
 * ## Why only localhost
 *
 * This is the one tool in the app that puts *arbitrary rendered content* inside
 * the window, and the model chooses the address. Restricting it to loopback is
 * the whole of the security story, and it is not a formality:
 *
 *   - An in-app frame pointed at an attacker-controlled page is a phishing
 *     surface wearing the app's chrome. The user has no address bar to check.
 *   - A page fetched from the internet can carry trackers and beacons, and this
 *     app's promise about voice is that nothing leaves the machine. A preview
 *     pane that quietly loads remote content undermines a guarantee made
 *     elsewhere.
 *   - The legitimate use is always local: the agent starts a server *here*.
 *     There is no case where "preview the thing you just built" means a public
 *     URL, so nothing is lost by refusing them.
 *
 * The check is on the parsed hostname, never on the string. `http://localhost@evil.com/`
 * and `http://127.0.0.1.evil.com/` both contain "127.0.0.1" and neither is
 * loopback, which is exactly why a substring test would be a hole rather than a
 * guard.
 */

/** Hostnames that are genuinely this machine. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export type PreviewTarget = { url: string; title: string } | null;

let current: PreviewTarget = null;

/** What the renderer should be showing, for a client that connects late. */
export const readPreview = (): PreviewTarget => current;

function publish(target: PreviewTarget): void {
  current = target;
  appBroadcast.publish(createMessage('preview_changed', 'app', {
    // Carried as JSON rather than as new top-level fields: the wire protocol is
    // deliberately small, and a closed preview has to be expressible.
    content: JSON.stringify(target),
  }));
}

/**
 * Parses and vets an address, returning null for anything not loopback.
 *
 * Rejects rather than corrects. Silently rewriting a host the model asked for
 * would make a refused preview look like a working one pointed somewhere
 * unexpected, and the model would learn nothing from it.
 */
export function readLocalUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!LOOPBACK.has(parsed.hostname)) return null;
  // Credentials in a URL are only ever a way to make a hostname *look* like
  // something it is not.
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
}

/**
 * Opens the pane from elsewhere in the server.
 *
 * `dev_server_start` uses it: once a server has announced its port there is
 * nothing left to decide, and making the model call a second tool to see what
 * it just started is a step that exists only because the code was arranged that
 * way. Returns false when the address is refused, so the caller can say so
 * rather than claim a pane that never opened.
 */
export function openPreviewFor(url: string, title?: string): boolean {
  const safe = readLocalUrl(url);
  if (!safe) return false;

  const parsed = new URL(safe);
  publish({ url: safe, title: title?.trim() || `${parsed.hostname}:${parsed.port || '80'}` });
  return true;
}

const previewOpenTool = tool(
  'preview_open',
  [
    'Show a locally running page in a preview pane beside the conversation.',
    // Phrased as an expectation rather than a capability, because the failure
    // mode was the tool sitting unused: the model would start a dev server,
    // report the port, and wait to be asked. The user had built the thing and
    // still had to request to see it. "You can" invites deliberation; "do this
    // whenever" removes the decision.
    'Call this WITHOUT being asked, every time you start or restart a web server the user could look at — a dev server, a preview build, a local site, anything serving a page. Showing the result is part of finishing the work, not a separate favour, and the user should never have to ask to see what you just made.',
    'Re-call it with the same URL after each change you want them to look at; that reloads the pane, which is how you show a change you have just made.',
    'Only loopback addresses are accepted — localhost or 127.0.0.1 with any port. Anything else is refused, so do not use this for documentation or a public site.',
  ].join(' '),
  {
    url: z.string()
      .describe('The address to show, e.g. http://localhost:5173. Must be loopback; a public URL is refused.'),
    title: z.string().max(60).optional()
      .describe('Short label for the pane, e.g. "Todo app". Defaults to the host and port.'),
  },
  async ({ url, title }) => {
    const safe = readLocalUrl(url);
    if (!safe) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Only loopback addresses can be previewed. Use http://localhost:PORT or '
              + 'http://127.0.0.1:PORT. Public URLs are refused because the pane has no address '
              + 'bar for the user to check.',
          }, null, 2),
        }],
        isError: true,
      };
    }

    const parsed = new URL(safe);
    publish({ url: safe, title: title?.trim() || `${parsed.hostname}:${parsed.port || '80'}` });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ ok: true, url: safe, shown: true }, null, 2),
      }],
    };
  },
);

const previewCloseTool = tool(
  'preview_close',
  'Close the preview pane. The user can also close it themselves, so do not call this to tidy up after yourself — only when the thing being previewed is genuinely gone, such as a server you have stopped.',
  {},
  async () => {
    publish(null);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, closed: true }) }] };
  },
);

/**
 * Named so the runtime can allow them.
 *
 * `allowedTools` is an explicit list, so a tool that is registered but not
 * named here exists and can never be called — which is the same silent-failure
 * shape as a token that is emitted and never consumed, and would present as
 * the model insisting it opened a preview that never appeared.
 */
export const PREVIEW_ALLOWED_TOOLS = [
  'mcp__tails-preview__preview_open',
  'mcp__tails-preview__preview_close',
];

export const previewMcpServer = createSdkMcpServer({
  name: 'tails-preview',
  version: '1.0.0',
  tools: [previewOpenTool, previewCloseTool],
});
