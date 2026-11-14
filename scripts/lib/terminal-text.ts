/**
 * Text for the setup scripts' terminal screens (the field check, the field
 * picker, the link stage): one palette, and widths that ignore colour codes.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** `s` without its colour codes. */
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** The characters of `s` a terminal shows: its length without colour codes. */
export const visibleWidth = (s: string) => stripAnsi(s).length;

/** `s` split into colour codes and the text between them, codes kept as their own parts. */
export const ansiParts = (s: string) => s.split(new RegExp(`(${ANSI.source})`));

/**
 * The screens' colours and marks: Employment Hero purple, Connecteam cyan,
 * changes yellow. With `color` off, plain text and `[ok]` / `[!]` / `[x]` / `[-]`.
 */
export function palette(color: boolean) {
  const c = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const p = { eh: c("35"), ct: c("36"), change: c("33"), dim: c("2"), bold: c("1"), ok: c("32"), bad: c("31") };
  return {
    ...p,
    mark: {
      ok: p.ok(color ? "✓" : "[ok]"),
      warn: p.change(color ? "⚠" : "[!]"),
      bad: p.bad(color ? "✗" : "[x]"),
      none: p.dim(color ? "–" : "[-]"),
    },
    /** The visible width of a mark. */
    markWidth: color ? 1 : 4,
  };
}

export type Palette = ReturnType<typeof palette>;

/**
 * Wraps a line at its `sep` separators to `w` wide, never cutting a part:
 * the first line keeps `s`'s leading spaces, continuations are indented. A
 * single part wider than `w` is broken (without its colours), rather than
 * losing the end of it.
 */
export function wrap(s: string, w: number, sep: string, indent = "      "): string[] {
  const lead = /^ */.exec(s)![0];
  const out: string[] = [];
  let line = "";
  for (const part of s.slice(lead.length).split(sep)) {
    const next = line ? `${line}${sep}${part}` : `${out.length ? indent : lead}${part}`;
    if (line && visibleWidth(next) > w) {
      out.push(line);
      line = `${indent}${part}`;
    } else line = next;
  }
  out.push(line);
  return out.flatMap((l) => {
    const plain = stripAnsi(l);
    if (plain.length <= w) return [l];
    const pieces: string[] = [];
    for (let k = 0; k < plain.length; k += w) pieces.push(plain.slice(k, k + w));
    return pieces;
  });
}
