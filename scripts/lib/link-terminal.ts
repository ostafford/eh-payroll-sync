/**
 * The link stage's terminal (#154): runs the screen full-screen, on the
 * alternate screen with single keys, until the admin saves or cancels. However
 * it ends - saved, cancelled, or an error - the terminal is given back as it
 * was, so the error and the wizard's next lines show (and reach its log).
 */
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { LinkKey, LinkScreen } from "./link-screen.js";

export interface LinkTerminal {
  stdin: Readable & { setRawMode(on: boolean): unknown };
  stdout: Writable & { columns?: number; rows?: number };
  color: boolean;
}

export function driveLinkScreen(screen: LinkScreen, { stdin, stdout, color }: LinkTerminal): Promise<"save" | "cancel"> {
  const draw = () =>
    stdout.write("\u001b[H\u001b[2J" + screen.render({ columns: stdout.columns || 100, rows: stdout.rows || 30, color }).join("\n"));
  stdout.write("\u001b[?1049h\u001b[?25l"); // alternate screen, hide cursor
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    const restore = () => {
      stdin.off("keypress", onKey);
      stdout.off("resize", onResize);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\u001b[?25h\u001b[?1049l");
    };
    const guarded = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        restore();
        reject(err);
      }
    };
    function onResize() {
      guarded(draw);
    }
    function onKey(str: string | undefined, key: LinkKey = {}) {
      guarded(() => {
        const done = screen.press(str, key);
        if (!done) return void draw();
        restore();
        resolve(done);
      });
    }
    stdin.on("keypress", onKey);
    stdout.on("resize", onResize);
    guarded(draw);
  });
}
