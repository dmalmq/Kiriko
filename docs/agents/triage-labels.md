# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Not triage labels

The `wayfinder:*` labels — `wayfinder:map`, `wayfinder:grilling`,
`wayfinder:prototype`, `wayfinder:research`, `wayfinder:task` — are a **separate
axis**. They record what kind of ticket something is inside a `/wayfinder` map,
not its triage state. An issue can carry one label from each axis. Never read
`wayfinder:task` as a triage state, and never substitute it for one.

GitHub's stock labels (`bug`, `enhancement`, `documentation`, `question`,
`duplicate`, `invalid`, `good first issue`, `help wanted`) are also untouched by
triage, except `wontfix`, which doubles as the canonical role above.
