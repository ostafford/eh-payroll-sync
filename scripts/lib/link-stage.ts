/**
 * The wizard's link stage (#154), end to end: load what it needs, build the
 * link list, let the admin work through the screen, and write the changed
 * `pending_link` rows. The script supplies the I/O: the API calls and D1 reads,
 * the terminal and `wrangler d1 execute`. No file is written; names and
 * emails stay on screen.
 */
import type { ConnecteamUser } from "../../src/connecteam/types.js";
import { applyFieldMap } from "../../src/mapping/apply.js";
import type { FieldMap } from "../../src/mapping/schema.js";
import { baselineAtConfirm } from "../../src/sync/baseline.js";
import { linkChanges, pendingLinkSql, type LinkChanges, type LinkUpsert } from "./link-changes.js";
import { differingDetails, type DifferingDetail } from "./link-details.js";
import { linkListInput, type LinkStageData } from "./link-input.js";
import { buildLinkList, type LinkPendingRow } from "./link-list.js";
import { createLinkScreen, linkScreenPeople, type LinkScreen } from "./link-screen.js";

export interface LinkStageDeps {
  load(): Promise<LinkStageData>;
  /** Runs the screen until the admin saves or cancels. */
  drive(screen: LinkScreen): Promise<"save" | "cancel">;
  /** Runs SQL against the deployment's D1, through the built config. */
  execute(sql: string): Promise<void>;
  print(line: string): void;
  now(): number;
  /** Rehearsing against saved data: show the SQL, run nothing. */
  rehearsal?: boolean;
  /**
   * Run before the first deploy (ADR-0012): an empty Link list goes live only
   * once the admin confirms nobody is already in EH.
   */
  beforeDeploy?: { confirm(question: string): Promise<boolean> };
  /**
   * Take each confirmed pair's Baseline now and store it with the link
   * (#230), keyed by `BASELINE_KEY`. Without it, no Baseline is stored and
   * the link takes one at approval, as before.
   */
  baseline?: { secret: string; fieldMap: FieldMap };
  /**
   * The details that differ for one person, by name: returns the units to
   * take from Connecteam (**Use Connecteam's**). The rest keep EH's.
   */
  chooseDetails?(person: string, details: readonly DifferingDetail[]): Promise<readonly string[]>;
}

export type LinkStageOutcome = "saved" | "unchanged" | "rehearsed" | "cancelled" | "unconfirmed";

const EMPTY_LIST_QUESTION =
  "The Link list is empty: everyone whose onboarding pack is approved will be created as a new employee in Employment Hero. Is nobody already in EH?";

/** How many people the Link list holds once `changes` are saved. */
function listSizeAfter(existing: readonly LinkPendingRow[], changes: LinkChanges): number {
  const removed = new Set(changes.remove);
  const ids = new Set(existing.map((p) => p.ctUserId).filter((id) => !removed.has(id)));
  for (const r of changes.upsert) ids.add(r.ctUserId);
  return ids.size;
}

/** The last screen: when the people on the Link list sync. */
function whenTheySync(print: (line: string) => void): void {
  print("");
  print("Held people sync at the next daily recheck, or straight away if their Connecteam profile is edited.");
  print("Everyone else on the Link list is linked when their onboarding pack is approved.");
}

/**
 * The changes with each pair's Baseline (#230), plus a re-confirm of every
 * kept pair that has none yet (confirmed before Baselines were stored). The
 * pack and EH record are read in memory only; just fingerprints are kept.
 */
async function withBaselines(
  data: LinkStageData,
  changes: LinkChanges,
  deps: LinkStageDeps & { baseline: NonNullable<LinkStageDeps["baseline"]> },
): Promise<LinkChanges> {
  const touched = new Set([...changes.remove, ...changes.upsert.map((r) => r.ctUserId)]);
  const unbaselined = data.pendingLinks.filter((p) => p.ehEmployeeId !== null && p.hasBaseline === false && !touched.has(p.ctUserId));
  const users = new Map<number, ConnecteamUser>(data.ctUsers.map((u) => [u.userId, u]));
  const ehById = new Map(data.ehEmployees.map((e) => [String(e.id), e]));
  const { secret, fieldMap } = deps.baseline;
  const upsert: LinkUpsert[] = [];
  for (const row of [...changes.upsert, ...unbaselined]) {
    const user = users.get(row.ctUserId);
    const eh = row.ehEmployeeId === null ? undefined : ehById.get(row.ehEmployeeId);
    if (!user || !eh) {
      upsert.push({ ctUserId: row.ctUserId, ehEmployeeId: row.ehEmployeeId, baseline: null });
      continue;
    }
    const mapped = applyFieldMap(user, fieldMap);
    const details = differingDetails(mapped.payload, eh, fieldMap);
    const who = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    const useConnecteam = details.length && deps.chooseDetails ? await deps.chooseDetails(who, details) : [];
    const unmapped = mapped.issues.map((i) => i.ehField);
    const baseline = await baselineAtConfirm(mapped.payload, fieldMap, secret, { useConnecteam, unmapped });
    upsert.push({ ctUserId: row.ctUserId, ehEmployeeId: row.ehEmployeeId, baseline });
  }
  return { upsert, remove: changes.remove };
}

export async function runLinkStage(deps: LinkStageDeps): Promise<LinkStageOutcome> {
  const data = await deps.load();
  const input = linkListInput(data);
  const screen = createLinkScreen(buildLinkList(input), linkScreenPeople(input));
  if ((await deps.drive(screen)) === "cancel") {
    deps.print("Nothing saved: the Link list is as it was.");
    return "cancelled";
  }
  const decided = linkChanges(input.pendingLinks, screen.decisions());
  // Asked before anything is written, so a no leaves the list as it was.
  if (deps.beforeDeploy && listSizeAfter(input.pendingLinks, decided) === 0 && !(await deps.beforeDeploy.confirm(EMPTY_LIST_QUESTION))) {
    deps.print("Nothing saved, and nothing is live yet. Run the link stage again to add anyone already in EH.");
    return "unconfirmed";
  }
  const changes = deps.baseline ? await withBaselines(data, decided, { ...deps, baseline: deps.baseline }) : decided;
  const sql = pendingLinkSql(changes, deps.now());
  if (!sql) {
    deps.print("No changes to the Link list.");
    whenTheySync(deps.print);
    return "unchanged";
  }
  const removed = changes.remove.length ? `, ${changes.remove.length} taken off the Link list` : "";
  const what = `${changes.upsert.length} link${changes.upsert.length === 1 ? "" : "s"} added or changed${removed}`;
  if (deps.rehearsal) {
    deps.print(`Rehearsal: nothing written. It would save ${what}.`);
    deps.print(sql);
    return "rehearsed";
  }
  await deps.execute(sql);
  deps.print(`Saved: ${what}.`);
  whenTheySync(deps.print);
  return "saved";
}
