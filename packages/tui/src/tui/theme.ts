/**
 * Colorschemes for the TUI — a six-role map swapped under the Ink `color` props.
 *
 * `t` is a mutable singleton: components read `t.accent` etc. at render time, so a
 * setTheme() + one root re-render restyles all live chrome. Rows already printed via
 * <Static> keep the colors they were printed with (terminal output is immutable).
 *
 * "minima" is the current look and the default: plain ANSI names that map to the user's
 * terminal palette. Every other theme uses hex (truecolor terminals; Ink degrades to
 * nearest-ANSI elsewhere). Body text stays the terminal's default foreground — themes
 * never paint a background, and only "minima" sets `text` (its historical "white").
 */

export interface ThemePalette {
  /** Selection / spinner / active elements. */
  accent: string;
  /** Plan mode. */
  plan: string;
  /** Secondary text. */
  dim: string;
  warn: string;
  success: string;
  error: string;
  /** Emphasized foreground; undefined = terminal default. */
  text: string | undefined;
}

export const THEMES: Record<string, ThemePalette> = {
  minima: {
    accent: "cyan",
    plan: "magenta",
    dim: "gray",
    warn: "yellow",
    success: "green",
    error: "red",
    text: "white",
  },
  claude: {
    accent: "#D97757",
    plan: "#9C8CD9",
    dim: "#94908A",
    warn: "#D2A54A",
    success: "#7DA269",
    error: "#E5484D",
    text: undefined,
  },
  mono: {
    accent: "#E8E8E8",
    plan: "#B8B8B8",
    dim: "#6E6E6E",
    warn: "#B3B3B3",
    success: "#C8C8C8",
    error: "#E5484D",
    text: undefined,
  },
  paper: {
    accent: "#B4552D",
    plan: "#6C5DA8",
    dim: "#8C877B",
    warn: "#9A7500",
    success: "#3E7A46",
    error: "#B3261E",
    text: undefined,
  },
  ember: {
    accent: "#E2A24A",
    plan: "#9D7CD8",
    dim: "#8C8578",
    warn: "#E7C664",
    success: "#98BB6C",
    error: "#E46876",
    text: undefined,
  },
  moss: {
    accent: "#8FB573",
    plan: "#B29FCC",
    dim: "#7E8878",
    warn: "#C9B458",
    success: "#6F9958",
    error: "#C34043",
    text: undefined,
  },
  ocean: {
    accent: "#7AA2C7",
    plan: "#9A86C8",
    dim: "#7E8794",
    warn: "#CBA55A",
    success: "#7FA666",
    error: "#CC6666",
    text: undefined,
  },
  iris: {
    accent: "#957FB8",
    plan: "#7E9CD8",
    dim: "#8A8A96",
    warn: "#C0A36E",
    success: "#76946A",
    error: "#C34043",
    text: undefined,
  },
  rose: {
    accent: "#D7827E",
    plan: "#907AA9",
    dim: "#9893A5",
    warn: "#F6C177",
    success: "#9CCFD8",
    error: "#EB6F92",
    text: undefined,
  },
  fjord: {
    accent: "#88C0D0",
    plan: "#B48EAD",
    dim: "#7B8394",
    warn: "#EBCB8B",
    success: "#A3BE8C",
    error: "#BF616A",
    text: undefined,
  },
};

export const THEME_NAMES = Object.keys(THEMES);

let current = "minima";

/** The live palette. Mutated in place so every module sees the switch. */
export const t: ThemePalette = { ...THEMES.minima! };

export function currentTheme(): string {
  return current;
}

/** Switch the live palette. Unknown names are ignored. Returns true when applied. */
export function setTheme(name: string): boolean {
  const palette = THEMES[name];
  if (!palette) return false;
  current = name;
  Object.assign(t, palette);
  return true;
}
