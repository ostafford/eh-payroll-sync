/**
 * The wizard's link stage (#154), end to end: load what it needs, build the
 * link list, let the admin work through the screen, and write the changed
 * `pending_link` rows. The script supplies the I/O: the API calls and D1 reads,
 * the terminal and `wrangler d1 execute`. No file is written; names and
 * emails stay on screen.
 */
import { linkChanges, pendingLinkSql } from "./link-changes.js";
import { linkListInput, type LinkStageData } from "./link-input.js";
import { buildLinkList } from "./link-list.js";
import { createLinkScreen, type LinkScreen } from "./link-screen.js";

export interface LinkStageDeps {
  load(): Promise<LinkStageData>;
  /** Runs the screen until the admin saves or cancels. */
  drive(screen: LinkScreen): Promise<"save" | "cancel">;
  /** Runs SQL against the deployment's D1, through the built config. */
  execute(sql: string): Promise<void>;
  print(line: string): void;
  now(): number;
}

export type LinkStageOutcome = "saved" | "unchanged" | "cancelled";

export async function runLinkStage(deps: LinkStageDeps): Promise<LinkStageOutcome> {
  const input = linkListInput(await deps.load());
  const list = buildLinkList(input);
  const people = {
    ct: new Map(input.ctUsers.map((u) => [u.ctUserId, u])),
    eh: new Map(input.ehEmployees.map((e) => [e.id, e])),
  };
  const screen = createLinkScreen(list, people);
  if ((await deps.drive(screen)) === "cancel") {
    deps.print("Nothing saved: the Link list is as it was.");
    return "cancelled";
  }
  const changes = linkChanges(input.pendingLinks, screen.decisions());
  const sql = pendingLinkSql(changes, deps.now());
  if (!sql) {
    deps.print("No changes to the Link list.");
    return "unchanged";
  }
  await deps.execute(sql);
  const removed = changes.remove.length ? `, ${changes.remove.length} taken off the Link list` : "";
  deps.print(`Saved: ${changes.upsert.length} link${changes.upsert.length === 1 ? "" : "s"} added or changed${removed}.`);
  deps.print("");
  deps.print("Held people sync at the next daily recheck, or straight away if their Connecteam profile is edited.");
  deps.print("Everyone else on the Link list is linked when their onboarding pack is approved.");
  return "saved";
}
