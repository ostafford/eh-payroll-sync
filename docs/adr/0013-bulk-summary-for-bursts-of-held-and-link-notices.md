# A burst of Held or Link notices posts one Bulk summary

## Status

accepted

## Context

At the first client go-live (2026-11-12) the first sweep drained a backlog of approvals, and each of 112 Held employees posted its own Existing-match notice to the alerts channel within a few minutes. To the client it read as the sync misbehaving (#193). With the link stage now run before the deploy (ADR-0012), the same backlog posts one Link notice per linked person instead, and the daily recheck re-queues Held employees 20 at a time, so a batch of links confirmed later does the same.

Each notice is sent from its own queue job. The sweep queues 20 approvals a tick, the queue delivers them 10 at a time, and consumer invocations can run in parallel, so no one invocation ever sees the whole burst.

We considered three options:

- **Send every Held and Link notice from the cron.** It sees the whole picture, but it adds up to a minute of delay and a new failure path to the normal one-at-a-time case.
- **Have the sweep declare a "bulk mode".** The sweep knows how big the backlog is, but not who ends up Held and who Linked, which only the job decides. It also misses the recheck.
- **Count recent notices in D1 and roll up the rest of a burst.** Chosen.

## Decision

Every Held or Link notice is recorded in `notice_rollup` (one row per person per kind). A job that finds 3 notices of its kind in the last 10 minutes still takes its claim (ADR-0007), but records the person as rolled up instead of sending. Each tick, once the sweep has run, the cron posts one **Bulk summary** per kind whose burst has been quiet for 3 minutes, or whose first person has waited 30 minutes, so a long drain isn't silent.

The summary is a count and where to act (the link stage, which lists each Held person), never names: about 15 names fit in one 500-character message, so a list would be the flood again.

Not rolled up:

- a Link notice naming details that differ in EH, which asks the admin to check them;
- the "can't link" System alert, and every other message type.

The numbers are constants in `src/sync/rollup.ts`, not per-client config.

## Consequences

- **The normal case is unchanged.** One approval still gets its own notice straight away.
- **In a burst, per-person detail leaves the channel.** After the first 3, the candidates and matched keys for a Held employee are in the link stage and `GET /status`, not in a message. An admin asking "why was there no notice for Jane?" is pointed here.
- **The summary arrives about 3 minutes after the burst ends,** or 30 minutes into a long one.
- **The threshold is soft.** Two parallel invocations can both read a count of 2 and both send, so a burst may post a few more than 3 one by one.
- **Retry-safe (ADR-0007, rows 6h and 11).** The burst is counted before any claim, so a failed count leaves nothing claimed. The roll-up record is written after the claim, so a re-run skips it, and a failed record write releases the claim, so the retry rolls the person up. A split Existing-match notice whose first part already went out is finished one by one, never half rolled up. The summary's people are picked first, in one D1 statement that stamps them with that summary, so anyone rolled up during the send waits for the next one. Then it's claimed, sent, and only its people cleared; a failed send releases the claim and puts them back to waiting. A tick that crashed partway leaves them stamped: the next tick clears them if the claim shows the summary went out, or puts them back if it didn't, so nobody is counted twice. Only an eviction between the claim and the record loses that person from the summary: the same at-most-once window ADR-0007 already accepts for a send.
- **The Admin success notice has the same go-live flood** and still relies on `adminSuccess: false` for the first run. The same mechanism can take it as a third kind.
