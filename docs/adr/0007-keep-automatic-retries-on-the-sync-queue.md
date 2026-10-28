# Keep automatic retries on the sync queue: every write is idempotent or claimed

## Status

accepted

## Context

`wrangler.jsonc` gives the `eh-payroll-sync-queue` consumer `max_retries: 5`, with a
dead-letter queue that raises a **System alert**. The integration playbook
(`../CLAUDE.md`, "Never auto-retry a non-idempotent write") says a consumer that
writes third-party data should use `max_retries: 0` and tell a human instead:
a queue retry re-runs the whole message, so after a partial failure it can
write the same records twice.

A Sync job is retried in two ways:

1. **It asks for one.** `runSyncJob` returns `status: "retry"` when Connecteam
   or Employment Hero is unavailable or returns an unexpected error, or when a
   Connecteam message fails to send (#89). Every such return happens before
   the link or audit row is saved. Earlier side effects are the EH write
   (row 1 below) and any message that already went out, which its claim
   stops the retry from repeating.
2. **It crashes partway**, from an unexpected throw or the Worker being evicted
   before the ack. The queue redelivers the message and the whole job runs
   again from the start. This is the case the playbook warns about.

The rule applies only if a re-run can repeat something. So every side effect
of `runSyncJob` and the dead-letter handler (`src/sync/consumer.ts`) is listed
below, with what a full re-run does to it.

| # | Side effect | How it is written | On a re-run of the same job | Verdict |
|---|---|---|---|---|
| 1 | **Employment Hero employee record** | `upsertByExternalId`: `GET …/externalid/{id}`, then `POST` if absent or `PUT` if present | If EH applied a write we never saw the answer to (e.g. a timeout), the re-run's `GET` finds it and `PUT`s the same payload. No second employee. | Idempotent |
| 2 | Read-back of the record | `GET` | Read only | — |
| 3 | **Correction message** to the employee, plus their **Direct manager** on cycle 3+ | One `sync_meta` claim per recipient (user + mapped-payload hash, 1 h), taken **before** sending. Employee: claim, send, then bump the cycle. Manager: its own claim, then send. A failed send releases its claim and the job retries (#89) | A claim that's held is skipped: no second message and no second cycle bump (#58). A released claim is sent by the retry | At most once per recipient |
| 4 | Failure-cycle count | `advanceCycle` | Correction: inside the employee claim, after the send succeeds (row 3). OK / Manual follow-up: set to 0, which can repeat | Idempotent |
| 5 | **Manual-follow-up notice** to the alerts channel | Claim (user + reasons, 12 h) before sending; released on a failed send, and the job retries | Not re-sent once sent | At most once |
| 6 | **Collision alert** to the alerts channel | Claim (1 h) before sending; released on a failed send, and the job retries before its audit row | Not re-sent once sent | At most once |
| 6a | **Success message** to the employee (#71): first successful sync, or a fixed Correction | One claim (user + mapped-payload hash, 1 h) covering both wordings, taken before sending and **before** the cycle reset; released on a failed send, and the job retries with the cycle still open | Not re-sent once sent; a retry after the cycle reset would pick the other wording, but finds the same claim held | At most once |
| 7 | `employee_map` link (`lastSyncedTs`, `lastPayloadHash`, `lastOutcome`) | Upsert of one row | Same values. Once saved, the stale-event guard and the payload hash skip any later redelivery of this job before step 1 | Idempotent |
| 8 | `sync_log` audit row | `INSERT`, written last | Normally skipped by row 7's guard. **Exception:** the collision path doesn't save a link, so a redelivery appends a second identical `collision` row | Audit only; can repeat on collisions |
| 9 | `acked_total` counter | Bumped once per batch, after the acks | A crash between an ack and the bump under-counts. The `/health` `queueBacklog` gauge can then stay above 0 | Gauge drift only |
| 10 | Dead-letter queue: **System alert**, `dead_letter` audit row, integrator alert | Alert claimed (1 h); a failed send releases the claim (can't retry, the DLQ always acks), so the next dead-letter for that user posts it; row `INSERT`; integrator alert de-duplicated per user (1 h, `src/index.ts`) | No repeated alerts; the row can repeat if the DLQ itself redelivers | At most once / audit |

Nothing a person or Employment Hero sees can be duplicated by a re-run. The
only repeatable writes are an audit row on the collision path and a health
counter.

## Decision

**Keep `max_retries: 5` on `eh-payroll-sync-queue`.** This is a documented exception
to the playbook's "never auto-retry" rule. The rule exists to prevent
duplicated third-party writes, and this consumer has none:

- **The one third-party write is an upsert** keyed by the Connecteam user id
  (EH `externalId`). Re-running it converges on the same record.
- **Every human-facing message is claimed before it is sent**, so a re-run
  skips it. Messages are at-most-once.
- **Everything else** is an idempotent upsert, an audit row, or a gauge.

The other half of the rule, surfacing failure to a human, is already met:
after the last retry the job dead-letters and the alerts channel gets a System
alert (row 10).

`max_retries: 0` would make things worse here. Almost every real failure is
transient: Connecteam or Employment Hero rate-limiting, a 5xx, a timeout. With
no retries, each blip would dead-letter the job, post a System alert, and
need someone to re-sync the employee by hand, where a retry seconds later
would have succeeded.

## Considered options

- **`max_retries: 0` + DLQ → System alert (the playbook default):** rejected for
  this consumer. It guards against duplication that can't happen here (see the
  table) and turns every transient fault into manual work.
- **Keep retries but make the remaining non-idempotent rows idempotent** (row 8's
  collision audit row, row 9's counter): not needed for this decision. They
  affect an audit trail and a gauge, never a person or EH.

## Consequences

- **An invariant for future changes:** any new side effect in `runSyncJob` must
  be idempotent, or claimed before it happens, like rows 3, 5 and 6. Otherwise
  this decision must be revisited. `src/sync/consumer.ts` points here.
  (`wrangler.jsonc` deliberately has no comment: the live deploy folder keeps
  its settings as uncommitted edits to that file, and upstream changes to it
  would block updating that folder.)
- **A failed send is retried, not lost (#89).** Every send's result is
  checked. On failure the claim is released, a `message_send_failed` event is
  logged, and the job returns `status: "retry"` before saving its link, so the
  queue redelivers it and the retry sends the message. If Connecteam stays
  down through every retry, the job dead-letters to a System alert. Each
  recipient of a Correction has its own claim, so a failed manager DM is
  retried without DMing the employee again. The cycle is bumped only after the
  employee DM succeeds, so a failed send never double-bumps it.
- **At-most-once still has a cost, now narrower:** a crash *between* a claim
  and its send (the Worker evicted mid-send) still loses that message. The
  re-run sees the claim and skips it. A crash between the employee DM and the
  cycle bump leaves the count one short (the message did go out). Both need an
  eviction in a window of milliseconds; a send that *reports* failure, the
  common case, is covered above.
- **Retries back off, and the total window is known (#90).** With no delay,
  Cloudflare redelivers a retried message in the next batch, so the five
  retries could be spent within seconds. `dispatchBatch` now retries with
  `message.retry({ delaySeconds })` from `retryDelaySeconds(attempts)`:
  30 s, 60 s, 2 min, 4 min, 8 min (doubling, capped at 8 min). The sixth and
  last delivery runs about **15.5 minutes** after the first. A job that is
  still failing then dead-letters. That covers a 5-minute Employment Hero or
  Connecteam outage with room to spare. The delay is set in code, not as
  `retry_delay` in `wrangler.jsonc`, so the live deploy folder's file is
  untouched.
- **The retry window must stay inside the claim windows.** A retried message
  must arrive while its claims are still held, or a late retry could re-send
  a message. The shortest is 1 h (Correction, Collision, System alert), so
  15.5 min leaves a wide margin. `test/sync-consumer.test.ts` reads
  `max_retries` from `wrangler.jsonc` and fails if the window passes half of
  the Correction claim or drops below 5 minutes. If you raise `max_retries`,
  that test tells you whether the backoff still fits.
- **The playbook rule still holds as the default** for other integrations under
  `../` (e.g. a write-per-record importer with no upsert key). This ADR is the
  record of why this consumer is the exception. A client's IT person asking
  "why does it retry?" can be pointed here.
