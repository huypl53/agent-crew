# Discussion Workflows for Party Mode

Structured workflows for different discussion types. Choose the pattern that matches your goal.

## Decision-Making Workflow

**Goal:** Reach a clear decision with documented rationale

**Rounds:**
1. **Diverge** — Each worker analyzes independently from their perspective
2. **Compare** — Leader shares Round 1, workers react to others' points
3. **Converge** — Workers refine positions based on new information
4. **Decide** — Leader synthesizes final recommendation

**Typical duration:** 3-4 rounds

**Success criteria:**
- Clear recommendation with rationale
- Documented trade-offs
- Dissenting views captured
- Action items defined

## Brainstorming Workflow

**Goal:** Generate diverse ideas without premature convergence

**Rounds:**
1. **Generate** — Workers propose ideas independently (no visibility)
2. **Build** — Workers see Round 1, build on others' ideas
3. **Cluster** — Leader groups similar ideas, workers validate groupings
4. **Prioritize** — Workers vote/rank top ideas

**Key rule:** No criticism in Round 1. Judgment comes later.

**Typical duration:** 2-3 rounds

## Problem Diagnosis Workflow

**Goal:** Identify root cause of an issue

**Rounds:**
1. **Symptoms** — Workers describe what they observe from their angle
2. **Hypotheses** — Workers propose potential causes
3. **Evidence** — Workers identify what evidence supports/refutes each hypothesis
4. **Root Cause** — Converge on most likely cause with supporting evidence

**Typical duration:** 3 rounds

## Retrospective Workflow

**Goal:** Reflect on past work, extract lessons

**Rounds:**
1. **What happened** — Workers describe events from their perspective
2. **What worked / What didn't** — Workers evaluate outcomes
3. **Why** — Workers analyze causes of successes and failures
4. **Next time** — Workers propose changes for future

**Typical duration:** 4 rounds (can combine 2+3)

## Quick Consensus Workflow

**Goal:** Fast alignment on low-stakes decisions

**Rounds:**
1. **Propose** — Leader states proposal, workers respond agree/disagree/modify
2. **Resolve** — If disagreements, workers address specific objections

**Typical duration:** 1-2 rounds

## Workflow Selection Guide

| Situation | Workflow | Rounds |
|-----------|----------|--------|
| Architecture decision | Decision-Making | 3-4 |
| Feature ideation | Brainstorming | 2-3 |
| Bug investigation | Problem Diagnosis | 3 |
| Sprint review | Retrospective | 4 |
| Minor choice | Quick Consensus | 1-2 |

## Round Pacing

**When to advance (`party next`):**
- All workers have responded, OR
- Timeout reached and sufficient responses collected, OR
- Remaining workers explicitly skipped

**When to end early (`party end`):**
- Clear consensus reached
- Decision is time-sensitive
- Discussion is circling without progress

**Signs of stalling:**
- Workers repeating same points
- No new information emerging
- Positions hardening without new arguments

## Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Premature convergence | All agree in Round 1 | Assign devil's advocate role |
| Endless divergence | No convergence after 4 rounds | Force decision, note dissent |
| Groupthink | Workers echo leader's framing | Leader withholds opinion until Round 2 |
| Scope creep | Discussion drifts to adjacent topics | Redirect to original question |
| Analysis paralysis | Workers want more data | Set decision deadline, decide with available info |
