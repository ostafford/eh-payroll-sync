/**
 * Turns an Employment Hero Payroll error body into a flat list of
 * `{ field, reason }`.
 *
 * Confirmed against the live API (issue #2): validation failures come back as
 * HTTP 400 with `{ "message": "Field: reason\nField: reason" }` - one string,
 * newline-separated, each line usually prefixed `Field: `. The other shapes
 * below are kept as defensive fallbacks.
 */
export interface EhFieldError {
  /** EH field name if the line named one, otherwise "(unknown)". */
  field: string;
  reason: string;
  /** The employee's own dropdown answer the sync can't use, so their Correction can name it. */
  answer?: UnusableAnswer;
}

/**
 * A Connecteam dropdown answer the sync can't send (#112): "TBC" to a Yes/No tax
 * question, or an option the field map leaves unmapped. Only ever shown back to
 * the employee who gave it, never logged, and never for a sensitive field.
 */
export interface UnusableAnswer {
  /** The question as the employee saw it (the Connecteam field's name). */
  question: string;
  value: string;
  /** "yesNo": a tax question needing Yes or No; "option": any other dropdown. */
  kind: "yesNo" | "option";
}

const NO_FIELD = "(unknown)";
const LINE = /^([A-Za-z0-9_.\[\]]+):\s+(.*\S)\s*$/;

/**
 * Shape 2 (issue #29): EH also sends validation reasons as bare prose with no
 * `Field:` prefix - "Tax File Number is invalid", "Tax free threshold can only
 * be claimed for Australian residents", "The sum of the allocated percentage
 * should total 100 for bank accounts". Map the known phrases back to an EH
 * field so the audit row names it and the employee-facing curated line
 * (src/sync/messages.ts) is chosen from the field as well as the words, instead
 * of falling through to the fully generic correction. First match wins, most
 * specific first; seed from what shows up in `sync_log` and extend.
 */
const COLONLESS_REASON_FIELDS: ReadonlyArray<{ match: RegExp; field: string }> = [
  { match: /tax file number/i, field: "taxFileNumber" },
  { match: /tax[-\s]?free threshold/i, field: "taxFreeThreshold" },
  { match: /allocated percentage.*\b(super|fund)/i, field: "superAllocation" },
  { match: /allocated percentage/i, field: "bankAccountAllocation" },
];

/** An EH field name for a colon-less reason line, or "(unknown)" if unrecognised. */
export function fieldForColonlessReason(reason: string): string {
  for (const { match, field } of COLONLESS_REASON_FIELDS) if (match.test(reason)) return field;
  return NO_FIELD;
}

function fromMessageString(message: string): EhFieldError[] {
  const out: EhFieldError[] = [];
  for (const raw of message.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    out.push(m ? { field: m[1]!, reason: m[2]! } : { field: fieldForColonlessReason(line), reason: line });
  }
  return out;
}

export function parseValidationBody(body: unknown): EhFieldError[] {
  // Primary: { message: "Field: reason\n..." } (also { Message: ... })
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    const message = typeof obj.message === "string" ? obj.message : typeof obj.Message === "string" ? obj.Message : null;
    if (message && message.trim() !== "") return fromMessageString(message);

    // Fallback: ModelState-style { FieldName: ["msg", ...] }
    const out: EhFieldError[] = [];
    for (const [key, value] of Object.entries(obj)) {
      const messages = Array.isArray(value) ? value : [value];
      for (const m of messages) {
        if (typeof m === "string" && m.trim() !== "") out.push({ field: key, reason: m.trim() });
      }
    }
    if (out.length) return out;
  }

  // Fallback: ["msg", "msg"]
  if (Array.isArray(body)) {
    const errs = body
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((raw) => raw.trim())
      .map((reason) => ({ field: fieldForColonlessReason(reason), reason }));
    if (errs.length) return errs;
  }

  // Fallback: bare string
  if (typeof body === "string" && body.trim() !== "") {
    return fromMessageString(body);
  }

  return [{ field: NO_FIELD, reason: "Employment Hero rejected the record but gave no detail." }];
}
