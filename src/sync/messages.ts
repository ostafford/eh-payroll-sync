/**
 * Composes the outbound message types (CONTEXT.md), all plain language and
 * clamped to 500 characters:
 *   1. Correction message      -> the employee, as a DM from the custom publisher
 *      (also the Direct manager on the 3rd consecutive failed cycle).
 *   2. Manual-follow-up notice  -> the admin channel.
 *   3. System alert             -> the admin channel.
 *   4. Success message          -> the employee, once on a first sync and once
 *      when a Correction is fixed (#71; per-client `messages.employeeSuccess`).
 *   5. Admin success notice     -> the admin channel, at the same two moments
 *      (per-client `messages.adminSuccess`).
 *   6. Existing-match notice    -> the admin channel, when the Pre-create check
 *      holds someone (ADR-0010).
 *   7. Link notice              -> the admin channel, when a first approval
 *      links a Pre-existing employee (ADR-0009), or their first sync does by
 *      a Payroll ID copied into Connecteam (ADR-0011), or a System alert when
 *      a confirmed link can't be made.
 *
 * Messages to a person (1 and 4) end with a short "this is automated" note
 * (per-client `messages.automatedNote`), kept whole however long the rest runs.
 *
 * Formatting: Connecteam chat shows `**text**` as bold and `__text__` as
 * underlined, on the web and in the phone app (tested on the demo account,
 * 2026-11-01; not in its API docs). `*text*` and HTML show as typed. Only `**`
 * is used (underlining reads like a link), and never on a message's first line,
 * which a phone's notification preview may show as typed.
 *
 * Employment Hero's raw error text is NEVER placed in a message - it goes to the
 * audit log only. Each recognised field maps to a curated, actionable line;
 * anything unrecognised falls back to one generic-but-actionable instruction.
 */
import type { EhFieldError, UnusableAnswer } from "../eh/errors.js";
import type { ExistingMatch, MatchKey } from "./precheck.js";
import type { RollupKind } from "./gateway.js";

const MAX_LEN = 500;

export const GENERIC_CORRECTION =
  "Some of the details you entered couldn't be saved to Employment Hero. Please review your personal, address, bank, tax and super details and correct anything that looks wrong.";

interface CuratedLine {
  match: RegExp;
  line: string;
  /** What the line is about, for the "that's fixed" message (#71). Several lines can share one. */
  topic: Topic;
}

/** A Correction topic as the employee would name it, with its verb number ("has" / "have"). */
interface Topic {
  name: string;
  plural: boolean;
}

const BANK: Topic = { name: "bank details", plural: true };
const ADDRESS: Topic = { name: "address", plural: false };

/**
 * First match wins, so order matters: most specific first. Matched against
 * `"<normalised field name> <lower-cased EH reason>"`, so a hit can come from
 * either the field EH named or the words in its message.
 */
const CURATED: CuratedLine[] = [
  { match: /bsb/, line: "Your bank BSB doesn't look right - check it's the 6-digit branch number for your account.", topic: BANK },
  { match: /accountnumber/, line: "Your bank account number doesn't look right - double-check it.", topic: BANK },
  { match: /accountname/, line: "The account-holder name on your bank account is missing.", topic: BANK },
  { match: /bankaccount|bank details|bankdetails/, line: "Your bank account details couldn't be saved - check the BSB, account number and account-holder name.", topic: BANK },
  { match: /taxfilenumber|tax file number|\btfn\b/, line: "Your Tax File Number doesn't appear to be valid - re-check the 9 digits.", topic: { name: "tax file number", plural: false } },
  { match: /tax[-\s]?free|tax declaration|taxdeclaration|australianresident|non-resident|not an australian resident|helpdebt|stsldebt|tax details|taxdetails/, line: "Your tax declaration answers are missing or inconsistent - review the tax questions.", topic: { name: "tax declaration", plural: false } },
  { match: /startdate|start date/, line: "Your employment start date is missing or in the wrong format.", topic: { name: "start date", plural: false } },
  { match: /dateofbirth|date of birth|birthday|\bdob\b/, line: "Your date of birth is missing or in the wrong format.", topic: { name: "date of birth", plural: false } },
  { match: /employmenttype|employment type/, line: "Your employment type must be Full time, Part time, Casual or Labour hire.", topic: { name: "employment type", plural: false } },
  { match: /gender/, line: "Your gender selection couldn't be saved - choose one of the listed options.", topic: { name: "gender", plural: false } },
  { match: /postcode|post code/, line: "Your postcode doesn't look right - check it's 4 digits.", topic: ADDRESS },
  { match: /residentialstate|\bstate\b/, line: "Your residential state couldn't be saved - pick your state from the list.", topic: ADDRESS },
  { match: /suburb|streetaddress|street address|\baddress\b/, line: "Your residential address looks incomplete - check the street address and suburb.", topic: ADDRESS },
  { match: /email/, line: "Your email address doesn't look valid - re-check it.", topic: { name: "email address", plural: false } },
  { match: /mobile|phone/, line: "Your mobile number doesn't look valid - enter it starting with +61.", topic: { name: "mobile number", plural: false } },
  { match: /super|fund|membernumber|\busi\b/, line: "Your super fund details look incomplete - check the fund USI or name and your member number.", topic: { name: "super details", plural: true } },
  { match: /emergency/, line: "Your emergency contact details look incomplete - check the name, number and relationship.", topic: { name: "emergency contact details", plural: true } },
  { match: /firstname|first name|surname|lastname|last name|basic details|basicdetails|\bname\b/, line: "Your legal name looks incomplete - check your legal first name and surname.", topic: { name: "legal name", plural: false } },
];

function normField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function curated(err: EhFieldError): CuratedLine | undefined {
  const hay = `${normField(err.field)} ${err.reason.toLowerCase()}`;
  return CURATED.find((c) => c.match.test(hay));
}

/** The curated plain-language line for one EH field error (never its raw text). */
export function friendlyLine(err: EhFieldError): string {
  return curated(err)?.line ?? GENERIC_CORRECTION;
}

/**
 * The employee's own dropdown answer the sync can't use, named back to them
 * (#112): they picked an option the client offered, so a generic "missing or
 * inconsistent" would confuse them. The wizard previews exactly this line.
 */
export function answerLine(a: UnusableAnswer): string {
  // Kept short: several have to fit in one 500-character message with the rest.
  const need = a.kind === "yesNo" ? "please change it to Yes or No." : "please choose a different option.";
  return `You answered "${a.value}" to **"${a.question}"** - ${need}`;
}

/**
 * What an EH field is, as an employee would name it ("bank details"), for the
 * admin digest's reasons; undefined when the field isn't a recognised one.
 */
export function correctionTopic(field: string): string | undefined {
  return curated({ field, reason: "" })?.topic.name;
}

/**
 * The distinct topics behind a Correction's field errors, in the order asked
 * (#71). A field with no curated line has no topic, so an all-unknown
 * Correction yields `[]`.
 */
export function correctionTopics(fields: readonly EhFieldError[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const name = curated(f)?.topic.name;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Success message -> the employee, once, on their first successful sync (#71). */
export function firstSyncMessage(note: string): string {
  return withNote("Thanks, your details have now been received in Employment Hero.", note);
}

/**
 * Success message -> the employee, once, when a Correction is fixed (#71).
 * Names what the Correction asked them to fix. Like {@link firstSyncMessage},
 * it never says "Complete": a record EH holds Incomplete for an admin's
 * award choice is still a success from the employee's side.
 */
export function correctionFixedMessage(topics: readonly string[], note: string): string {
  if (topics.length === 0) return withNote("Thanks, that's fixed: your details have now been updated in Employment Hero.", note);
  const plural = topics.length > 1 || CURATED.some((c) => c.topic.name === topics[0] && c.topic.plural);
  return withNote(
    `Thanks, that's fixed: your ${topicList(topics)} ${plural ? "have" : "has"} now been updated in Employment Hero.`,
    note,
  );
}

/** "a", "a and b", "a, b and c". */
function topicList(topics: readonly string[]): string {
  return topics.length === 1 ? topics[0]! : `${topics.slice(0, -1).join(", ")} and ${topics.at(-1)}`;
}

/**
 * Admin success notice -> the admin channel, on an employee's first successful
 * sync. Same moment as {@link firstSyncMessage}; per-client
 * `messages.adminSuccess`.
 */
export function adminFirstSyncMessage(ref: PersonRef): string {
  return clamp(`✅ ${personLabel(ref)} has synced to Employment Hero.`);
}

/** Admin success notice -> the admin channel, when a Correction is fixed. */
export function adminCorrectionFixedMessage(ref: PersonRef, topics: readonly string[]): string {
  const what = topics.length === 0 ? "details" : topicList(topics);
  return clamp(`✅ ${personLabel(ref)} fixed their ${what} and has now synced to Employment Hero.`);
}

/** `toEmployee`: name the employee's own answer where there is one (never in a manager's copy). */
function friendlyLines(fields: EhFieldError[], toEmployee = false): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const line = toEmployee && f.answer ? answerLine(f.answer) : friendlyLine(f);
    if (!out.includes(line)) out.push(line);
  }
  if (out.length === 0) return [GENERIC_CORRECTION];
  // Drop the catch-all if we also have at least one specific line.
  return out.length > 1 ? out.filter((l) => l !== GENERIC_CORRECTION) : out;
}

// The employee's Correction (style picked on the demo account, 2026-11-01): ✏️ opens it,
// ❗ marks each problem, ➡️ says where to fix it.
const CORRECTION_HEAD = "✏️ Hi - a few of the details you entered need a quick fix before they can be saved to Employment Hero:";
const CORRECTION_MARK = "❗";
/** A Correction never runs to more messages than this; past it, bullets are counted ("...and 2 more"). */
const MAX_CORRECTION_PARTS = 3;
/** Room for a part's "(1 of 3) " label: one digit each side, so never more than {@link MAX_PARTS}. */
const PART_LABEL = "(9 of 9) ".length;
const MAX_PARTS = 9;

function correctionFoot(lines: readonly string[], profilePath: string, note: string): string[] {
  return [
    `➡️ To fix: go to **${profilePath}** and update ${lines.length === 1 ? "it" : "them"}.\nWe'll sync again automatically once you save.`,
    ...noteLines(note),
  ];
}

/**
 * Correction message -> the employee who entered the bad data, as one message.
 * Ends with where to fix it (`profilePath`, per client: sections are the
 * client's choice). The sync sends {@link correctionMessages}, which is this
 * when it fits.
 */
export function correctionMessage(fields: EhFieldError[], profilePath: string, note: string): string {
  const lines = friendlyLines(fields, true);
  return fitList([CORRECTION_HEAD], lines, correctionFoot(lines, profilePath, note), CORRECTION_MARK);
}

/**
 * The Correction as the employee is sent it: one message when everything fits,
 * otherwise "(1 of 2)", "(2 of 2)"... (at most {@link MAX_CORRECTION_PARTS}),
 * each within the cap, so no problem is hidden (#112: answers named back to the
 * employee are long). The greeting opens the first part; "To fix" and the
 * automated note close the last.
 */
export function correctionMessages(fields: EhFieldError[], profilePath: string, note: string): string[] {
  const lines = friendlyLines(fields, true);
  return numberedParts([CORRECTION_HEAD], lines, correctionFoot(lines, profilePath, note), CORRECTION_MARK, MAX_CORRECTION_PARTS);
}

/**
 * A bulleted message as one message when it fits, otherwise "(1 of 2)",
 * "(2 of 2)"... (at most `maxParts`, and never past {@link MAX_PARTS}), each
 * within the cap. The head opens the first part and the foot closes the last;
 * past `maxParts`, the last part counts the rest ("...and 2 more").
 */
function numberedParts(
  head: readonly string[],
  lines: readonly string[],
  foot: readonly string[],
  mark: string,
  maxParts: number,
): string[] {
  const body = (first: boolean, items: readonly string[], last: boolean, more = 0) =>
    sections(
      ...(first ? head : []),
      bulletList([...items, ...(more > 0 ? [`...and ${more} more`] : [])], mark),
      ...(last ? foot : []),
    );
  const whole = body(true, lines, true);
  if (whole.length <= MAX_LEN) return [whole];

  const fits = (first: boolean, items: readonly string[], last: boolean, more = 0) =>
    PART_LABEL + body(first, items, last, more).length <= MAX_LEN;

  // Fill parts with bullets in order; the closing lines go in the last part, or one of their own.
  const parts: string[][] = [[]];
  for (const line of lines) {
    const cur = parts.at(-1)!;
    if (cur.length && !fits(parts.length === 1, [...cur, line], false)) parts.push([line]);
    else cur.push(line);
  }
  // No room for the closing lines: the last bullet moves on with them, so no part is just "To fix".
  const last = parts.at(-1)!;
  if (!fits(parts.length === 1, last, true)) parts.push(last.length > 1 ? [last.pop()!] : []);

  const max = Math.min(maxParts, MAX_PARTS);
  let more = 0;
  if (parts.length > max) {
    parts.length = max - 1;
    const rest = lines.slice(parts.flat().length);
    let keep = rest.length;
    while (keep > 0 && !fits(false, rest.slice(0, keep), true, rest.length - keep)) keep--;
    parts.push(rest.slice(0, keep));
    more = rest.length - keep;
  }

  const n = parts.length;
  return parts.map((items, i) => {
    const text = body(i === 0, items, i === n - 1, i === n - 1 ? more : 0);
    return clamp(i === 0 ? `(1 of ${n}) ${text}` : `(${i + 1} of ${n})\n${text}`);
  });
}

/**
 * How an employee is referred to in an admin-facing message. The name makes the
 * channel scannable; the id stays for an unambiguous lookup. Falls back to
 * "Connecteam user <id>" when the name is not to hand (e.g. a dead-letter alert
 * raised without a fresh user fetch).
 */
export interface PersonRef {
  ctUserId: number;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
}

export function personLabel(ref: PersonRef): string {
  const name = [ref.firstName, ref.lastName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return name ? `${name} (${ref.ctUserId})` : `Connecteam user ${ref.ctUserId}`;
}

/** Correction message -> the Direct manager, on the 3rd failed cycle in a row. */
export function managerEscalationMessage(fields: EhFieldError[], ref: PersonRef | undefined, note: string): string {
  const who = ref ? `, ${personLabel(ref)},` : "";
  return fitList(
    [
      `Heads up: an employee you manage${who} has had their details fail to sync to Employment Hero three times in a row.`,
      "They've been asked to correct:",
    ],
    friendlyLines(fields),
    ["Please check in with them so their Employment Hero record can be completed.", ...noteLines(note)],
  );
}

/** Manual-follow-up notice -> the admin channel. */
export function followUpNoticeMessage(reasons: string[], ref: PersonRef): string {
  const items =
    reasons.length > 0 ? reasons : ["A payroll admin needs to review this record in Employment Hero."];
  return clamp(
    sections(
      `Employment Hero follow-up needed for ${personLabel(ref)}:`,
      bulletList(items),
      "The sync completed with safe defaults - finish this by hand in Employment Hero.",
    ),
  );
}

/** Resolved notice -> the admin channel, when the daily recheck (#43) finds a follow-up now Complete in EH. */
export function resolvedNoticeMessage(ref: PersonRef, status: string): string {
  return clamp(`✅ ${personLabel(ref)} is now ${status} in Employment Hero - no more action needed.`);
}

/** System alert -> the admin channel, when a queue message dead-letters. */
export function systemAlertMessage(detail: string, ref: PersonRef): string {
  return clamp(
    sections(
      `Employment Hero sync failed for ${personLabel(ref)} and could not be retried.`,
      detail.trim() ? `Detail: ${detail.trim()}` : "No further detail was returned.",
      "No employee action is possible - check the Employment Hero API status and credentials.",
      "Once fixed, edit their profile in Connecteam to sync again.",
    ),
  );
}

/**
 * System alert -> the admin channel, when a write lands on an EH employee id
 * already linked to a DIFFERENT Connecteam user. Employment Hero's
 * unstructured-employee endpoint matches/merges by TFN internally, so two
 * people who happen to share a TFN (a data-entry mistake, a placeholder value
 * never replaced) can get silently spliced into one EH record - see
 * `SyncGateway.findByEhEmployeeId`.
 */
export function collisionAlertMessage(ehEmployeeId: string, ref: PersonRef, otherCtUserId: number): string {
  return clamp(
    sections(
      `The sync for ${personLabel(ref)} landed on Employment Hero employee ${ehEmployeeId}, which is already linked to a different Connecteam user (id ${otherCtUserId}).`,
      "Employment Hero likely matched them by a duplicate value (e.g. the same Tax File Number) instead of creating a separate record.",
      "No employee action is possible - a payroll admin must check and separate these two records directly in Employment Hero.",
    ),
  );
}

const MATCH_KEY_NAMES: Record<MatchKey, string> = {
  email: "email",
  tfn: "TFN",
  nameDob: "name + date of birth",
};

/** "email and TFN differ", "TFN differs": key names only, with the verb agreeing. */
function keyPhrase(keys: readonly MatchKey[], verb: "match" | "differ"): string {
  return `${topicList(keys.map((k) => MATCH_KEY_NAMES[k]))} ${keys.length === 1 ? `${verb}${verb === "match" ? "es" : "s"}` : verb}`;
}

/** "EH 40213 (Terminated in EH): email and TFN match; name + date of birth differs". Key names only, never values. */
export function existingMatchLine(m: ExistingMatch): string {
  const who = `EH ${m.ehEmployeeId}${m.terminated ? " (Terminated in EH)" : ""}`;
  if (m.byPayrollId) {
    const differ = m.differs.length ? ` (${keyPhrase(m.differs, "differ")})` : "";
    return `${who}: Payroll ID matched, but no other detail agreed${differ}`;
  }
  const differs = m.differs.length ? `; ${keyPhrase(m.differs, "differ")}` : "";
  return `${who}: ${keyPhrase(m.matched, "match")}${differs}`;
}

const EXISTING_MATCH_FOOT = [
  "➡️ To fix: re-run the setup wizard's link stage and either link them to the right employee or mark them **New hire, not this person**.",
  "They'll sync at the next daily recheck, or straight away when their profile is edited.",
];

/** An Existing-match notice's line for a Payroll ID copied into Connecteam that EH doesn't hold (ADR-0011). */
export const PAYROLL_ID_TYPO_HINT = "Their Payroll ID in Connecteam isn't in EH; check it for a typo.";

/**
 * An Existing-match notice's line when their Payroll ID field was blank and a
 * match already has a Payroll ID in EH: filling it in links them (ADR-0011).
 */
export function copyPayrollIdHint(fieldName: string): string {
  return `Copy their EH Payroll ID into **${fieldName}** in Connecteam.`;
}

/**
 * Existing-match notice -> the admin channel, when the Pre-create check holds
 * someone (ADR-0010, #143 item 8): each possible EH match with the keys that
 * matched or disagreed, never their values, and how to fix it. One message
 * when it fits, otherwise numbered parts, each within the cap: the heading
 * opens the first, "To fix" closes the last. Past {@link MAX_PARTS} parts the
 * rest are counted, which takes dozens of candidates. `notes` go before "To
 * fix", e.g. {@link PAYROLL_ID_TYPO_HINT}.
 */
export function existingMatchMessages(ref: PersonRef, matches: readonly ExistingMatch[], notes: readonly string[] = []): string[] {
  const head = [
    `⚠️ Held: ${personLabel(ref)} may already be in Employment Hero, so nothing was written for them.`,
    matches.length === 1 ? "Possible match:" : "Possible matches:",
  ];
  return numberedParts(head, matches.map(existingMatchLine), [...notes, ...EXISTING_MATCH_FOOT], "•", MAX_PARTS);
}

/**
 * Link notice -> the admin channel, when a Pre-existing employee's first
 * approval links them (ADR-0009, #143 item 6). It replaces the Admin success
 * notice; the employee gets nothing. The name isn't bold, as it would be on
 * the first line (see the module doc).
 */
export function linkNoticeMessage(
  ref: PersonRef,
  ehEmployeeId: string,
  payrollIdSet: boolean,
  /** Keys that disagree with the EH record, for a link by a copied Payroll ID (ADR-0011). Names only. */
  differs: readonly MatchKey[] = [],
): string {
  const differ = differs.length
    ? `Their ${keyPhrase(differs, "differ")} in Employment Hero: check which is right.`
    : "";
  return clamp(
    sections(
      `🔗 ${personLabel(ref)} is now linked to Employment Hero employee ${ehEmployeeId}.`,
      `${payrollIdSet ? "Only the Payroll ID was set." : "Their Payroll ID was already in Employment Hero, so nothing was written."} From now on, only what they change in Connecteam is synced.`,
      differ,
    ),
  );
}

/**
 * Bulk summary -> the admin channel (#193, ADR-0013): one message for everyone
 * whose Existing-match, Link or Admin success notice rolled up in a burst (#199). A count only, never names:
 * the link stage lists each Held person, and a list would be the flood again.
 */
export function bulkSummaryMessage(kind: RollupKind, count: number): string {
  const one = count === 1;
  // No default: a new kind doesn't compile until it has its own wording.
  switch (kind) {
    case "existing_match":
      return sections(
        `⚠️ Held: ${count} more ${one ? "person" : "people"} may already be in Employment Hero, so nothing was written for them.`,
        `➡️ To fix: re-run the setup wizard's link stage, which lists ${one ? "them" : "each of them"}, and either link them to the right employee or mark them **New hire, not this person**. \`GET /status\` also lists them, as waiting on admin.`,
        EXISTING_MATCH_FOOT[1]!,
      );
    case "link":
      return sections(
        `🔗 ${count} more Pre-existing ${one ? "employee is" : "employees are"} now linked to Employment Hero.`,
        "For each, only the Payroll ID was set, or nothing was written if Employment Hero already had it. From now on, only what they change in Connecteam is synced.",
      );
    case "admin_success":
      return sections(
        `✅ ${count} more ${one ? "employee has" : "employees have"} synced to Employment Hero.`,
        `\`GET /status\` lists ${one ? "them" : "each of them"}, as ready.`,
      );
  }
}

/** Why a confirmed link couldn't be made. EH ids and Connecteam ids only, never a value. */
export type LinkBlock =
  | { kind: "different_payroll_id" }
  | { kind: "payroll_id_elsewhere"; ehEmployeeId: string }
  | { kind: "linked_in_sync"; otherCtUserId: number }
  | { kind: "not_found" }
  | { kind: "payroll_id_rejected" };

function linkBlockReason(ehEmployeeId: string, b: LinkBlock): string {
  switch (b.kind) {
    case "different_payroll_id":
      return `Employment Hero employee ${ehEmployeeId} already has a different Payroll ID, so it belongs to someone else.`;
    case "payroll_id_elsewhere":
      return `Their Payroll ID is already on a different Employment Hero employee, ${b.ehEmployeeId}.`;
    case "linked_in_sync":
      return `Employment Hero employee ${ehEmployeeId} is already linked to Connecteam user ${b.otherCtUserId}.`;
    case "not_found":
      return `Employment Hero has no employee ${ehEmployeeId} any more.`;
    case "payroll_id_rejected":
      return `Employment Hero wouldn't accept their Payroll ID on employee ${ehEmployeeId}.`;
  }
}

/** System alert -> the admin channel, when a confirmed link can't be made: nothing was written. */
export function linkBlockedMessage(ref: PersonRef, ehEmployeeId: string, block: LinkBlock): string {
  return clamp(
    sections(
      `Can't link ${personLabel(ref)} to Employment Hero employee ${ehEmployeeId}, so nothing was written for them.`,
      linkBlockReason(ehEmployeeId, block),
      "➡️ To fix: check both records in Employment Hero, then re-run the setup wizard's link stage for them.",
    ),
  );
}

/**
 * System alert -> the admin channel, when a synced person's mapped Payroll ID
 * no longer matches the one fixed at their first sync (ADR-0011). Neither ID
 * is named: the admin looks both up.
 */
export function payrollIdChangedMessage(ref: PersonRef): string {
  return clamp(
    `The Payroll ID for ${personLabel(ref)} changed in Connecteam; the sync still uses the old one. Change it in both places by hand if that's intended.`,
  );
}

/**
 * Manual-follow-up notice -> the admin channel, when a Linked employee blanked
 * a field in Connecteam (ADR-0009, #152). Nothing clears an EH field safely,
 * so the sync left EH as it was. `heldBack` names the rest of a group now
 * partly blank: it goes whole or not at all, so an edit to it wasn't sent
 * either. Informational: it doesn't change the sync's outcome.
 */
export function clearedFieldsMessage(cleared: readonly string[], heldBack: readonly string[], ref: PersonRef): string {
  return clamp(
    sections(
      `${personLabel(ref)} cleared these in Connecteam, and the sync doesn't clear fields in Employment Hero:`,
      bulletList(cleared),
      "If they should be blank, clear it by hand in Employment Hero. Otherwise no action is needed.",
      heldBack.length > 0
        ? `Also not sent, as they're in the same group: ${heldBack.join(", ")}. If any of these changed, update them by hand in Employment Hero.`
        : "",
    ),
  );
}

/**
 * System alert -> the admin channel, once per new `BASELINE_KEY` (ADR-0009,
 * #152): Linked employees' Baselines were made with another key, so each is
 * re-baselined on their next sync with nothing sent. Names nobody: it's about
 * every Linked employee.
 */
export function baselineKeyChangedMessage(): string {
  return clamp(
    sections(
      "The Baseline key (BASELINE_KEY) changed, so Linked employees are re-baselined against their current Connecteam profile as they next sync. Nothing is sent to Employment Hero for them until they edit their profile again.",
      "Any Connecteam edit not yet synced before the change won't be sent. If the key was lost rather than rotated on purpose, see the RUNBOOK's \"Rotating keys\".",
    ),
  );
}

/**
 * The closing "this is automated" line on a message to a person (per client:
 * `messages.automatedNote`; blank for none). Admin-channel messages don't
 * carry it: admins know where those come from.
 */
function noteLines(note: string): string[] {
  return note.trim() ? [note.trim()] : [];
}

/** A short message plus its automated note, the note kept whole if the body is cut. */
function withNote(body: string, note: string): string {
  const tail = noteLines(note).map((l) => `${GAP}${l}`).join("");
  return `${clamp(body, MAX_LEN - tail.length)}${tail}`;
}

/**
 * A blank line between a message's parts: Connecteam chat keeps line breaks,
 * and without the gap a message reads as one block.
 */
const GAP = "\n\n";

function sections(...parts: string[]): string {
  return parts.filter((p) => p.trim()).join(GAP);
}

export function bulletList(items: readonly string[], mark = "•"): string {
  return items.map((l) => `${mark} ${l}`).join("\n");
}

/**
 * A bulleted message within the length cap, keeping its closing lines: those
 * say what to do next, so bullets are dropped from the end (with a count of
 * how many) rather than the whole text being cut short.
 */
function fitList(head: string[], items: string[], foot: string[], mark = "•"): string {
  const render = (kept: string[]) => {
    const more = items.length - kept.length;
    return sections(...head, bulletList([...kept, ...(more > 0 ? [`...and ${more} more`] : [])], mark), ...foot);
  };
  let kept = items;
  while (kept.length > 1 && render(kept).length > MAX_LEN) kept = kept.slice(0, -1);
  return clamp(render(kept));
}

function clamp(text: string, max = MAX_LEN): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
