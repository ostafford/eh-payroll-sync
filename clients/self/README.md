# `clients/self/`

This deployment's field map. **One repo clone = one client**, so the map lives
here and the Worker loads it by default (no `FIELD_MAP_CLIENT` needed).

`field-map.json` ships as a **placeholder** (a copy of `clients/_example/`).
During onboarding, `npm run discover -- --client self` overwrites it with a draft
built from the client's real Connecteam fields and Employment Hero IDs. Tune that
draft, then `npm test` (the loader tests fail fast on an invalid map).

**Employee success messages** (#71) are on here: `"messages": {
"employeeSuccess": true }`, so each employee gets one "Thanks…" DM on their
first successful sync and when a Correction is fixed (never on an ordinary
edit). Set it to `false`, commit and deploy to turn them off. A map without the
`messages` line has them **on** too.

**Admin success notices** are on here too (`"adminSuccess": true`): a ✅ in the
alerts channel at the same two moments, so an admin sees each new hire land.
On a new client's go-live, every existing approved employee syncs at once, so
consider setting it to `false` for that first run and switching it on after.

**`profilePath`** is where an employee edits their details in the Connecteam
app. Every Correction message ends "To fix: go to <profilePath> and update
it." Profile sections are each client's own choice, so confirm it on their app.

**`automatedNote`** is the closing line on every message to an employee or
manager, so nobody mistakes it for a colleague writing. The default ("This is
an automated message from the Employment Hero sync.") suits any client; set
their own wording, or `""` for none. Admin-channel messages never carry it.

Running several clients from one deployment instead? Add each under
`clients/<slug>/`, register it in `src/mapping/registry.ts`, and set
`FIELD_MAP_CLIENT=<slug>`.

**`field-picks.json`** (#112) records which of the client's own Connecteam
fields feeds each field the sync needs: `{ "id": 43566219 }` (plus, for a
dropdown, `"options": { "Full-time": "FullTime", "PBV": null }`, where `null`
means not synced: a Correction message), `{ "skip": true }`
(optional fields only), or `{ "create": true }` (waiting on `create-fields`,
which swaps in the new field's ID). The wizard's field check (`npm run field-check`)
writes it. The field check, `create-fields` and `discover` all read it before
matching by name. Remove an entry to be asked about that field again.
