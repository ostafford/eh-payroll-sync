# Client demo talk-track

What to say when you show the integration to a client. Each point goes with
the part of the demo where it comes up, so the client hears it before they
find it on their own.

When the integration's behaviour changes, update this file in the same PR as
`RUNBOOK.md`.

## Identity fields

- **Legal name, not profile name (#70).** "Employment Hero gets the
  employee's **legal** name, from the Legal First Name and Legal Surname
  fields. The name on their Connecteam profile is what they like to be called,
  and it doesn't go to payroll. So if someone changes their profile name and
  payroll doesn't change, that's working as intended. To change a name in
  payroll, edit the Legal field."

## Messages

- **Corrections say where to go.** "If something can't be saved to Employment
  Hero, the employee gets a chat message naming the field and ending 'To fix:
  go to Profile > Personal Information and update it.' The sync runs again by
  itself as soon as they save. Your profile sections might be named
  differently; we set the path to match your app."
- **The alerts group sees each new hire land.** "When someone first syncs, or
  fixes something they were asked to, a ✅ with their name goes to the alerts
  group. On go-live day every existing employee syncs at once, so after the
  first few the rest are counted in one summary message instead of flooding
  the group."
- **Every message says it's automated.** "Messages come from 'Employment Hero
  Sync (Automated)' and end with a line saying they were sent automatically,
  so nobody thinks a colleague is writing to them. You can change that line to
  your own wording."
