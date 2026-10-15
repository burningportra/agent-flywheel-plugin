# Dueling Idea Wizards Report: prompt provenance

**Date:** 2026-10-15T14:22:00Z
**Mode:** `--mode=architecture --top=3 --rounds=1`

## Score Matrix

| Idea | Origin | CC Score | COD Score | GMI Score | Avg | Verdict |
|---|---|---|---|---|---|---|
| Durable provenance | CC | self | 920 | 860 | 890 | consensus-winner |
| Shared cache | COD | 900 | self | n/a | 900 | contested |

## Consensus Winners (scored 700+ by all agents)

### 1. Durable provenance

**Strongest surviving critique:** The embedded ```json block can close a fixed-width prompt fence.

**Steelman summary:** Derive provenance from the report at bead-creation time instead of copying it into checkpoint state.

## Contested Ideas (large score gap between agents)

### Shared cache

**Agent scores:** cc=900, cod=510, gmi=n/a

**Strongest surviving critique:** Cache invalidation still has no single owner.

**Contested:** true
