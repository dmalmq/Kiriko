# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase. This repo is **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

Neither exists yet. If a file listed here is absent, **proceed silently**. Don't
flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill
(reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them
lazily when terms or decisions actually get resolved.

## Where this repo's decisions actually live today

`docs/adr/` is empty, but the project is not undocumented — architectural
decisions are recorded elsewhere, and an agent that only checks `docs/adr/` will
miss them:

| Source | Holds |
|---|---|
| `docs/superpowers/plans/2026-07-24-kiriko-platform-roadmap.md` §8 | The **decision register** — the de-facto ADR set. Each row is a decision plus its revisit trigger. Also §1.2 phase order, which controls future sequencing, and §7 cross-phase constraints. |
| `docs/superpowers/specs/2026-07-17-kiriko-platform-architecture-design.md` | Current architecture; controls implemented behaviour. |
| `docs/gdb-data-reference.md` | GDB schema, layer inventory, floor-label mapping, and the GDB→GeoJSON→KVB→routing pipeline. Read before touching GDB import, `kiriko-route`, `kiriko-facilities`, or KVB sections. |
| `docs/issue-attachments-operations.md` | Storage, lifecycle, security, and operations contract for rich comments and first-party media. |
| `PRODUCT.md`, `DESIGN.md` | Product and visual intent, including the Kiriko palette and accessibility floors. |
| Closed GitHub issues | The `wayfinder:grilling` and `wayfinder:prototype` issues carry resolution comments that are the decision of record for the 3D workstream (#19–#33). |

Treat the roadmap's §8 register as authoritative for "is this already decided?"
until `/domain-modeling` migrates decisions into `docs/adr/`. Where the roadmap
and a dated spec disagree: the roadmap controls future sequencing, the
architecture spec controls implemented behaviour.

## File structure

```
/
├── CONTEXT.md          ← glossary (not yet created)
├── docs/
│   ├── adr/            ← ADRs (not yet created)
│   └── agents/         ← this directory
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to
synonyms the glossary explicitly avoids.

Until `CONTEXT.md` exists, the vocabulary in use is already consistent across the
codebase and docs — for example *venue*, *venue version*, *level*, *unit*,
*opening*, *KVB section*, *scene source*, *canonical graph*, *finding*,
*association*, *provenance*. Follow existing usage rather than inventing
synonyms, and note real gaps for `/domain-modeling`.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR — or a row in the roadmap's decision
register — surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

A register row names its own revisit trigger. Say whether that trigger has fired.
