/**
 * The link stage's terminal driver (#154): whatever happens on the screen, the
 * terminal is given back as it was - raw mode off, cursor shown, the
 * alternate screen left - so the error and the wizard's own lines can show.
 */
import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
import type { LinkScreen } from "../scripts/lib/link-screen.js";
import { driveLinkScreen } from "../scripts/lib/link-terminal.js";

function fakeTerminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, raw: false, setRawMode(on: boolean) { stdin.raw = on; return stdin; } });
  const written: string[] = [];
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  stdout.on("data", (d) => written.push(String(d)));
  return { stdin, stdout, written: () => written.join("") };
}

const screenThat = (press: LinkScreen["press"]) => ({ press, render: () => ["frame"] }) as unknown as LinkScreen;

describe("driveLinkScreen", () => {
  it("gives the terminal back when the admin saves", async () => {
    const t = fakeTerminal();
    const done = driveLinkScreen(screenThat(() => "save"), { stdin: t.stdin, stdout: t.stdout, color: false });
    t.stdin.write("y");
    await expect(done).resolves.toBe("save");
    expect(t.stdin.raw).toBe(false);
    expect(t.written()).toMatch(/\u001b\[\?1049h[\s\S]*\u001b\[\?25h\u001b\[\?1049l$/);
  });

  it("gives the terminal back, then passes the error on, when a key goes wrong", async () => {
    const t = fakeTerminal();
    const done = driveLinkScreen(
      screenThat(() => {
        throw new Error("boom");
      }),
      { stdin: t.stdin, stdout: t.stdout, color: false },
    );
    t.stdin.write("x");
    await expect(done).rejects.toThrow("boom");
    expect(t.stdin.raw).toBe(false);
    expect(t.written()).toMatch(/\u001b\[\?25h\u001b\[\?1049l$/);
  });
});
