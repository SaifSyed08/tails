/**
 * What the desktop pet is waiting to tell you.
 *
 * A list rather than a single alert, because more than one conversation can
 * finish while you are away and each of them is cleared by a different act —
 * opening *that* chat. Dropping all but the last would mean the other chats
 * never announce themselves at all; queueing them one at a time would mean the
 * second only appears once the first is dealt with, which is a worse kind of
 * nagging. So: they all stay, the newest is the one he holds up, and the rest
 * are counted.
 *
 * Kept in the main process. The renderer sees the turn finish, but only the
 * shell knows whether the window is in front of you, and only the shell can
 * still speak to the pet window while the app is minimised.
 *
 * Pure, and separate from the shell, so the parts worth checking — what he says
 * when three chats finish, what happens when the same one finishes twice — can
 * be checked without an Electron window.
 */

/** How much of a chat's name fits in a bubble beside a 130px pet. */
export const MAX_TITLE = 32;

/**
 * Shortens a chat's name for the bubble.
 *
 * Titles are short summaries now, so most arrive shorter than this and are left
 * exactly as they are. The ellipsis is a single character rather than three
 * dots: it is one glyph of a very small budget.
 */
export function truncateTitle(title, max = MAX_TITLE) {
  const clean = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!clean) return 'A chat';
  if (clean.length <= max) return clean;

  // Cut on a word boundary when there is one nearby, because "Fix the drag…" is
  // a name and "Fix the dra…" is a typo.
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max - 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Records a finished conversation, newest last.
 *
 * The same chat finishing twice replaces its entry rather than adding one: it
 * is one chat waiting for you, however many turns it ran while you were away.
 */
export function addAlert(alerts, alert) {
  const rest = alerts.filter((entry) => entry.sessionId !== alert.sessionId);
  return [...rest, { sessionId: alert.sessionId, title: alert.title, at: alert.at }];
}

export function clearAlert(alerts, sessionId) {
  return alerts.filter((entry) => entry.sessionId !== sessionId);
}

/**
 * What to put in the bubble, or null when there is nothing to say.
 *
 * The newest chat is named and the others are counted, because a name is what
 * makes the bubble worth reading and a count is what stops it lying about how
 * much is waiting.
 */
export function describeAlerts(alerts) {
  if (alerts.length === 0) return null;

  const newest = alerts[alerts.length - 1];
  const others = alerts.length - 1;

  return {
    sessionId: newest.sessionId,
    text: `${truncateTitle(newest.title)} is ready!`,
    others,
  };
}
