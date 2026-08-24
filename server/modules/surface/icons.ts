/**
 * The icons a widget may name.
 *
 * A closed list, like every other vocabulary the agent draws from, and for the
 * same reason: an open one means an icon the app cannot draw, which renders as
 * a gap where a meaning was supposed to be.
 *
 * ## Why a curated hundred rather than the whole set
 *
 * The bundled icon library ships more than five thousand. Almost all of that is
 * unreachable in practice — nobody composing a panel about a test run needs
 * three variants of a French horn — and listing them would put a hundred
 * kilobytes of names in the tool schema for a model to read on every turn.
 *
 * These are chosen for what panels are actually about: status, direction, code
 * and version control, files, time, money, people, network, and the handful of
 * things that mean "look at this". Names match the icon library's own, so a
 * model that has seen it before guesses correctly.
 */
export const WIDGET_ICONS = [
  'check', 'x', 'triangle-alert', 'circle-alert', 'circle-check', 'circle-x',
  'info', 'circle-help', 'ban', 'clock', 'hourglass', 'trending-up',
  'trending-down', 'arrow-up', 'arrow-down', 'arrow-right', 'minus', 'plus',
  'code', 'terminal', 'git-branch', 'git-commit-horizontal', 'git-merge', 'git-pull-request',
  'bug', 'package', 'box', 'layers', 'database', 'server',
  'cpu', 'hard-drive', 'cloud', 'cloud-off', 'file', 'file-text',
  'file-code', 'folder', 'folder-open', 'save', 'download', 'upload',
  'trash2', 'copy', 'mail', 'message-square', 'bell', 'bell-off',
  'send', 'share2', 'user', 'users', 'user-check', 'heart',
  'star', 'thumbs-up', 'thumbs-down', 'dollar-sign', 'credit-card', 'receipt',
  'wallet', 'coins', 'calendar', 'timer', 'history', 'refresh-cw',
  'play', 'pause', 'square', 'skip-forward', 'globe', 'link',
  'search', 'filter', 'eye', 'eye-off', 'lock', 'unlock',
  'key', 'shield', 'zap', 'flame', 'sparkles', 'wand2',
  'lightbulb', 'target', 'flag', 'map-pin', 'compass', 'gauge',
  'activity', 'chart-bar', 'chart-pie', 'list', 'grid3x3', 'settings',
  'sliders-horizontal', 'wrench', 'rocket', 'coffee', 'moon', 'sun',
  'cloud-rain', 'leaf', 'music', 'image', 'camera', 'mic',
  'volume2', 'bookmark', 'pin', 'tag', 'inbox', 'archive',
  'external-link',
] as const;

export type WidgetIcon = typeof WIDGET_ICONS[number];
