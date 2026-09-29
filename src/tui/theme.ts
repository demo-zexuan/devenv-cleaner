/**
 * TUI Theme Tokens and Colour Helpers
 *
 * The only module under `tui/` that knows what a colour is: every component
 * receives a `Theme` and asks it for a token instead of naming a hue itself.
 *
 * I. Why colour is centralised
 *
 * 1. A palette change is a one-line edit here, and no component can smuggle a
 *    literal ANSI escape or hex literal into a rendered frame.
 * 2. `theme.plain` is the accessibility switch. When it is true every helper
 *    below returns unstyled text, and the components drop Ink's own style props
 *    (`color`, `backgroundColor`, `bold`, `dimColor`, `borderColor`) along with
 *    it. A plain frame therefore contains **zero** ANSI escapes, which is what
 *    makes the TUI safe to pipe, to capture in a log file, and to read with a
 *    screen reader.
 *
 * II. Palette choice
 *
 * 1. Only the terminal's own colour *names* are used. Named colours are remapped
 *    by the user's profile, so one palette stays legible on a dark and on a
 *    light terminal theme; a hex literal can only ever be tuned for one of them.
 * 2. `muted` and `dim` deliberately resolve to the same portable grey. They are
 *    two meanings — secondary information versus disabled information — that
 *    happen to share one ink; inventing a second grey would imply a distinction
 *    the design does not make.
 *
 * III. Detection belongs to the container
 *
 * 1. `makeTheme` never reads `process.env` and never probes a TTY. The container
 *    owns that decision (it knows about `--no-color`, the stream type and the
 *    environment) and passes the verdict as `plain`, or hands over the raw
 *    `NO_COLOR` value as `noColorEnv` for the one rule that is pure data. That
 *    keeps this module free of I/O and trivially testable.
 *
 * @module tui/theme
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import picocolors from 'picocolors';

import { displayWidth, pad } from '../core/format.js';
import type { RiskLevel, TargetLayer } from '../core/types.js';

/** The design tokens every TUI component renders against. */
export interface Theme {
  readonly colors: {
    primary: string;
    accent: string;
    muted: string;
    success: string;
    warning: string;
    danger: string;
    text: string;
    dim: string;
  };
  /** True when colour must be suppressed (NO_COLOR / not a TTY / --no-color). */
  readonly plain: boolean;
}

/**
 * The built-in palette.
 *
 * I. Token meanings
 *
 * 1. `primary` frames the interface: panel borders, headings, the chip for the
 *    active filter. It is the colour that says "this is structure".
 * 2. `accent` marks *user intent*: the selection marker and the focus bar. It is
 *    deliberately the furthest hue from `primary` so a selected row can never be
 *    confused with a border.
 * 3. `success` / `warning` / `danger` carry meaning only, never decoration.
 * 4. `text` is the strongest foreground available for literal values inside a
 *    dialog; body copy carries no explicit colour at all, so it inherits the
 *    terminal's own default and stays readable on a light profile.
 */
export const DEFAULT_THEME: Theme = {
  colors: {
    primary: 'cyan',
    accent: 'magenta',
    muted: 'gray',
    success: 'green',
    warning: 'yellow',
    danger: 'red',
    text: 'white',
    dim: 'gray',
  },
  plain: false,
};

/**
 * A colour table whose formatters are permanently enabled.
 *
 * I. Why the table is built here instead of importing the default export
 *
 * 1. `picocolors`' default export disables itself when the *process* has
 *    `NO_COLOR` or no TTY. That decision belongs to `Theme.plain`: a container
 *    that renders with `plain: false` has already decided colour is safe, and a
 *    second, invisible opinion inside a colour library would make the same theme
 *    render differently in two runs of the same command.
 * 2. `createColors(true)` exists for exactly this reason. The disabled table is
 *    never needed because {@link colored} short-circuits on `theme.plain`.
 */
const RICH = picocolors.createColors(true) as unknown as Readonly<Record<string, unknown>>;

/**
 * Resolve a colour name to its formatter.
 *
 * I. Guard rails
 *
 * 1. `Object.hasOwn` is checked first: a plain-object lookup would otherwise
 *    hand back `Object.prototype.constructor` for the name `constructor` and
 *    happily "colourise" with it. The name reaches this function from callers as
 *    well as from the palette, so the check is not theoretical.
 * 2. An unknown name degrades to identity rather than throwing mid-frame: a
 *    mistyped token must not destroy the screen it was meant to decorate.
 *
 * @param color - Colour name, e.g. `cyan`.
 * @returns The formatter, or undefined when the name is not a known colour.
 */
function formatterFor(color: string): ((value: string) => string) | undefined {
  if (!Object.hasOwn(RICH, color)) return undefined;
  const candidate = RICH[color];
  return typeof candidate === 'function' ? (candidate as (value: string) => string) : undefined;
}

/**
 * Build a theme, resolving the plain-text verdict.
 *
 * I. Precedence
 *
 * 1. An explicit `plain: true` wins outright — the container has already looked
 *    at the stream, the flag and the environment.
 * 2. Otherwise `noColorEnv` is honoured per the NO_COLOR specification: colour
 *    is suppressed when the variable is *present and non-empty*. An empty string
 *    is the "declared but unset" form some shells export, and treating it as
 *    "disable" would make an empty assignment silently strip the interface.
 *
 * @param options - Plain-text verdict and/or the raw `NO_COLOR` value.
 * @returns A theme with the default palette and the resolved `plain` flag.
 *
 * @example
 * ```ts
 * makeTheme()                              // colour on
 * makeTheme({ plain: true })               // colour off
 * makeTheme({ noColorEnv: '1' })           // colour off
 * makeTheme({ noColorEnv: '' })            // colour on
 * ```
 */
export function makeTheme(options: { readonly plain?: boolean; readonly noColorEnv?: string } = {}): Theme {
  const noColorSet = options.noColorEnv !== undefined && options.noColorEnv !== '';
  return { colors: DEFAULT_THEME.colors, plain: options.plain === true || noColorSet };
}

/** Which palette token each lifecycle layer is drawn with. */
const LAYER_TOKEN: Readonly<Record<TargetLayer, keyof Theme['colors']>> = {
  dependencies: 'primary',
  build: 'accent',
  cache: 'success',
  artifacts: 'warning',
};

/** Which palette token each risk level is drawn with. */
const RISK_TOKEN: Readonly<Record<RiskLevel, keyof Theme['colors']>> = {
  safe: 'success',
  low: 'primary',
  medium: 'warning',
  high: 'danger',
};

/** The four-character word shown inside a risk chip. */
const RISK_WORD: Readonly<Record<RiskLevel, string>> = {
  safe: 'SAFE',
  low: 'LOW',
  medium: 'MED',
  high: 'HIGH',
};

/**
 * Width of the standard risk chip, in characters.
 *
 * Every risk word is centred inside this width, so a column of chips lines up
 * whether it holds `LOW` or `HIGH`. Four characters of word plus two of padding
 * is the narrowest cell that still reads as a badge rather than as an initial.
 */
const RISK_BADGE_WIDTH = 6;

/**
 * Colour token for a lifecycle layer.
 *
 * @param theme - Active theme.
 * @param layer - Layer to colour.
 * @returns A colour name from `theme.colors`.
 */
export function layerColor(theme: Theme, layer: TargetLayer): string {
  return theme.colors[LAYER_TOKEN[layer]];
}

/**
 * Colour token for a risk level.
 *
 * The ramp is green → cyan → yellow → red so a single glance down the risk
 * column reads as a severity gradient rather than as four unrelated colours.
 *
 * @param theme - Active theme.
 * @param risk - Risk level to colour.
 * @returns A colour name from `theme.colors`.
 */
export function riskColor(theme: Theme, risk: RiskLevel): string {
  return theme.colors[RISK_TOKEN[risk]];
}

/**
 * Wrap a value in a colour, or leave it untouched when colour is suppressed.
 *
 * I. Contract
 *
 * 1. This is the *only* place a string is turned into an ANSI sequence, which is
 *    why `theme.plain === true` is a complete guarantee: every coloured string in
 *    the frame came through here.
 * 2. The value is colourised as a whole. Callers must pad *before* calling, and
 *    must never pad the result — a padded ANSI string is measured including its
 *    escapes and every column after it drifts.
 * 3. An unknown colour name is identity, matching {@link formatterFor}.
 *
 * @param value - Plain text to colour.
 * @param color - Colour name from the theme.
 * @param theme - Active theme.
 * @returns The coloured or untouched value.
 *
 * @example
 * ```ts
 * colored('12 MB', 'green', theme)   // '12 MB', wrapped in the green SGR pair
 * colored('12 MB', 'green', plain)   // '12 MB', byte for byte
 * ```
 */
export function colored(value: string, color: string, theme: Theme): string {
  if (theme.plain) return value;
  const format = formatterFor(color);
  return format ? format(value) : value;
}

/**
 * Centre a value inside a fixed width, without colouring it.
 *
 * I. Why centring lives here rather than in `core/format.ts`
 *
 * 1. `pad` offers left and right alignment because a table column needs both;
 *    a *chip* needs centring so its ink lands in the middle of the cell. This
 *    composes `pad` instead of duplicating it.
 * 2. It is exported separately from {@link chip} because a focused row paints a
 *    single foreground across the whole row and therefore needs the padding
 *    without the per-cell colour.
 *
 * @param value - Cell text.
 * @param width - Exact cell width in columns.
 * @returns A string occupying exactly `width` columns.
 */
export function centre(value: string, width: number): string {
  // Centring subtracts a *display* width, so a Chinese label lands in the
  // middle of its cell instead of drifting right by one column per wide glyph.
  const left = Math.max(0, Math.floor((width - displayWidth(value)) / 2));
  return pad(' '.repeat(left) + value, width);
}

/**
 * Centre a value inside a fixed width and colourise the whole cell.
 *
 * I. Ordering
 *
 * 1. The colour is applied after padding, so the chip's trailing spaces carry
 *    the colour too — which is what makes a background-coloured chip a solid
 *    block rather than a tinted word. Callers must never pad the result.
 *
 * @param theme - Active theme.
 * @param value - Chip text.
 * @param color - Colour name from the theme.
 * @param width - Exact cell width in characters.
 * @returns A string of exactly `width` visible characters.
 */
export function chip(theme: Theme, value: string, color: string, width: number): string {
  return colored(centre(value, width), color, theme);
}

/**
 * The standard risk badge.
 *
 * I. Shape
 *
 * 1. The chip is normalised to six visible characters rather than to the width
 *    of its word, so `LOW` and `HIGH` occupy the same cell and the risk column
 *    never ripples. Localised labels are rendered with {@link chip} directly,
 *    which is why the word table here stays internal and English.
 *
 * @param theme - Active theme.
 * @param risk - Risk level to render.
 * @returns A six-character chip, coloured unless the theme is plain.
 */
export function riskBadge(theme: Theme, risk: RiskLevel): string {
  return chip(theme, RISK_WORD[risk], riskColor(theme, risk), RISK_BADGE_WIDTH);
}

/**
 * Ink `<Text>` style props derived from the theme.
 *
 * Deliberately a plain object rather than JSX so the theme module stays free of
 * React: the same tokens are usable from a non-React reporter.
 */
export interface TextStyle {
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly dimColor?: boolean;
  readonly bold?: boolean;
}

/** Backgrounds dark enough to need light ink on top of them. */
const DARK_INK_BACKGROUNDS: ReadonlySet<string> = new Set([
  'black',
  'blue',
  'gray',
  'grey',
  'blackBright',
  'blueBright',
]);

/**
 * Pick a readable foreground for a given background.
 *
 * I. Why a fixed pair and not a contrast calculation
 *
 * 1. Only two inks are ever right on a terminal: black on the mid-tone and
 *    bright backgrounds, white on the dark ones. Computing luminance would mean
 *    parsing colour names, and the answer would still be black or white.
 *
 * @param theme - Active theme, for the light ink.
 * @param background - Background colour name.
 * @returns A colour name that reads on that background.
 */
export function onColor(theme: Theme, background: string): string {
  return DARK_INK_BACKGROUNDS.has(background) ? theme.colors.text : 'black';
}

/**
 * Style props for ordinary text.
 *
 * @param theme - Active theme.
 * @param color - Foreground colour, omitted to inherit the terminal default.
 * @param options - Extra emphasis to apply in colour mode.
 * @returns Ink style props; empty when the theme is plain.
 */
export function textStyle(
  theme: Theme,
  color?: string,
  options: { readonly bold?: boolean; readonly dim?: boolean } = {},
): TextStyle {
  if (theme.plain) return {};
  const style: { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean } = {};
  if (color !== undefined) style.color = color;
  if (options.dim === true) style.dimColor = true;
  if (options.bold === true) style.bold = true;
  return style;
}

/**
 * Style props for a filled highlight bar or chip.
 *
 * @param theme - Active theme.
 * @param background - Fill colour name.
 * @returns Ink style props with a contrasting foreground; empty when plain.
 */
export function barStyle(theme: Theme, background: string): TextStyle {
  if (theme.plain) return {};
  return { backgroundColor: background, color: onColor(theme, background), bold: true };
}

/**
 * The background fill for a bar, or undefined when colour is suppressed.
 *
 * Kept separate from {@link barStyle} because Ink paints a `<Box>`
 * `backgroundColor` across its whole content area, which is what makes the focus
 * bar span the full row instead of only the text inside it.
 *
 * @param theme - Active theme.
 * @param background - Fill colour name.
 * @returns A colour name for `<Box backgroundColor>`, or undefined when plain.
 */
export function barBackground(theme: Theme, background: string): string | undefined {
  return theme.plain ? undefined : background;
}
