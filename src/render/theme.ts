/**
 * Shared rendering primitives: escaping, palettes, and number formatting.
 *
 * Lifted out of the Sankey renderer once a second chart needed them. Keeping one palette matters
 * more than the code reuse — two charts of the same data in subtly different greens read as two
 * unrelated things, and the investor-class colours in particular have to mean the same thing
 * everywhere they appear.
 */
/** Escape text for inclusion in SVG markup. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ThemeName = "dark" | "light";

export interface Theme {
  bg: string;
  title: string;
  muted: string;
  rule: string;
  /** Ribbon alpha — dark needs more to read against a low-luminance background. */
  ribbonAlpha: number;
  asing: string;
  lokal: string;
  pemerintah: string;
  unknown: string;
  /** Column-header accents. Buying and selling are opposite roles; colour says so at a glance. */
  buyer: string;
  seller: string;
}

/**
 * Palettes.
 *
 * Dark is the default: these charts are read next to terminals and editors, and the hues are picked
 * for contrast against a dark ground (the light theme's #2563eb/#059669 go muddy there, which is
 * exactly the failure that makes a chart unreadable rather than merely ugly).
 */
export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    bg: "#0d1117",
    title: "#e6edf3",
    muted: "#8b949e",
    rule: "#21262d",
    ribbonAlpha: 0.34,
    asing: "#58a6ff",
    lokal: "#3fb950",
    pemerintah: "#e3b341",
    unknown: "#8b949e",
    buyer: "#3fb950",
    seller: "#f85149",
  },
  light: {
    bg: "#ffffff",
    title: "#111827",
    muted: "#6b7280",
    rule: "#e5e7eb",
    ribbonAlpha: 0.22,
    asing: "#2563eb",
    lokal: "#059669",
    pemerintah: "#d97706",
    unknown: "#6b7280",
    buyer: "#059669",
    seller: "#dc2626",
  },
};

/** Colour by investor class. Stockbit labels these in Indonesian. */
export function colorFor(investorType?: string, theme: Theme = THEMES.dark): string {
  const t = (investorType ?? "").toLowerCase();
  if (t.startsWith("asing")) return theme.asing; // foreign
  if (t.startsWith("lokal")) return theme.lokal; // local
  if (t.startsWith("pemerintah")) return theme.pemerintah; // government
  return theme.unknown;
}

/** Compact IDR/lots for a label: 1_234_567_890 -> "1.23B". */
export function humanAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(n)) return "-";
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

