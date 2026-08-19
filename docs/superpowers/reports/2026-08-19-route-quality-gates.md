# Route quality gates

**Date:** 2026-08-19
**Venue:** not measured
**Source:** generated (`synth_medial`), not Tokyo imported

No JR Takanawa / Shibuya IMDF zip and no generated `.kvb` was available as an `analyze_synth` path on this machine. Smart Connect was not exercised (no running generated venue). Numeric fields and named-pair evidence are therefore `not measured`, not zero.

## analyze_synth

| Field | Value |
|---|---|
| pair_count | not measured |
| routed_count | not measured |
| vertex_retention | not measured |
| length_ratio | not measured |
| leftover_near_wall_max | not measured |
| leftover_near_wall_mean | not measured |
| stretch_rho_max | not measured |
| stretch_sample_count | not measured |
| chord_edges | not measured |

## Named pairs

| Pair | What looks wrong | LOS already cuts it? | Smart Connect `shorter`? | Class |
|---|---|---|---|---|
| not measured | not measured | not measured | not measured | not claimed |

## Gates

- `rdp:` no
- `destination_chords:` no

### rdp = yes only if
leftover_near_wall_max ≥ 2 on wheelchair routes **and** at least one leftover is a corner (not a lock) that a 0.5 m RDP would drop.

### destination_chords = yes only if
stretch_rho_max ≥ 1.6 on a concourse-scale floor **and** ≥2 named pairs in the same class **and** Smart Connect already proposes `shorter` for those pairs (walkable geometry allows the diagonal; the stored graph does not).
