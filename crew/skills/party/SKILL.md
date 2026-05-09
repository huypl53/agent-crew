---
name: crew:party
description: Run structured multi-worker discussions with round-gated visibility
---

# Party Mode

Party mode enables structured group discussions where a leader broadcasts a topic to all workers, collects their responses, and controls when workers see each other's replies.

## Project Context

Workers should ground their responses in project constraints. Include these references in topic framing:

```
Consider the following project context:
- Development rules: `./rules/development-rules.md`
- Code standards: `./docs/code-standards.md`
- System architecture: `./docs/system-architecture.md`
- Orchestration protocols: `./rules/orchestration-protocol.md`
```

## Advisor Perspectives

For architectural discussions, assign different perspectives to workers:

| Perspective | Focus | Questions to Answer |
|-------------|-------|---------------------|
| **Systems Designer** | Boundaries, interfaces, data flows | How do components interact? What are the contracts? |
| **Tech Strategist** | Stack choices, patterns, best practices | What technologies fit? What patterns apply? |
| **Scalability Consultant** | Performance, reliability, growth | Will it scale? What are the bottlenecks? |
| **Risk Analyst** | Trade-offs, dependencies, failure modes | What could go wrong? What are we trading off? |

**Example topic with perspectives:**
```
Topic: Should we use GraphQL or REST for our new API?

Worker-A: Evaluate as Systems Designer — focus on schema design, type safety, and client-server contracts.
Worker-B: Evaluate as Tech Strategist — focus on ecosystem maturity, tooling, and team expertise.
Worker-C: Evaluate as Risk Analyst — focus on complexity, learning curve, and migration risks.
```

Workers respond from their assigned angle, then leader synthesizes.

## Starting a Party

Leader starts a discussion by broadcasting a topic:

```bash
crew party start --topic "How should we implement the auth system?" --name leader-name
```

This:
1. Broadcasts topic to all workers in the room
2. Workers receive the topic and respond naturally
3. Leader receives responses as they come in (via hook capture)

## Viewing Responses

Leader can check which workers have responded:

```bash
crew party status --name leader-name
```

Shows current round, responded workers, and pending workers.

## Advancing Rounds

After reviewing responses, leader advances to next round:

```bash
crew party next --name leader-name
```

This:
1. Sends a digest of all Round N responses to all workers
2. Workers now see each other's previous round responses
3. Opens Round N+1 for continued discussion

Workers only see responses from completed rounds - not the current round.

## Skipping Non-Responsive Workers

If a worker hasn't responded within timeout (default 5 min):

```bash
crew party skip --worker worker-name --name leader-name
```

Marks the worker as skipped for this round so `party next` can proceed.

## Ending the Party

Leader closes the discussion:

```bash
crew party end --name leader-name
```

Sends final digest to all workers and deactivates party mode.

## Response Capture

Worker responses are captured automatically via Claude Code's Stop hook. When a worker's turn ends, their `last_assistant_message` is captured and associated with the current party round.

Workers don't need special commands - they just respond naturally to the topic.

## Environment Variables

- `CREW_PARTY_TIMEOUT_MS`: Timeout for non-responsive workers (default: 300000 = 5 min)

## Typical Flow

```
1. Leader: crew party start --topic "Design question..."
2. Workers: (respond naturally to the topic)
3. Leader: crew party status  (check who responded)
4. Leader: crew party next    (share round 1 responses, open round 2)
5. Workers: (respond to round 2 with visibility of round 1)
6. Leader: crew party end     (close discussion)
```

---

## Worker Response Format

Guide workers to structure their responses consistently:

```
## Analysis
[Understanding of the problem from your assigned perspective]

## Recommendation
[Your position — be specific, not "it depends"]

## Trade-offs
- Pro: [advantage of your recommendation]
- Con: [disadvantage or risk]

## Confidence
[High/Medium/Low] — [why this confidence level]
```

**Key rules for workers:**
- Be honest and brutal — no hedging or people-pleasing
- Take a position — "it depends" is not an answer
- Acknowledge uncertainty — state confidence level explicitly
- Stay in your lane — focus on your assigned perspective

---

## Topic Framing Template

Good topics produce good discussions. Use this structure:

```
## Context
[1-2 sentences on background — what problem we're solving, why now]

## Question
[Specific question to answer — avoid vague "what do you think about X"]

## Constraints
- [Technical constraints: stack, performance, compatibility]
- [Business constraints: timeline, budget, team size]
- [Non-negotiables: must-haves vs nice-to-haves]

## Perspectives Needed
- [What angles should workers consider?]
- [Security? Performance? UX? Maintainability?]

## Expected Output
[What form should answers take? Options list? Recommendation? Trade-off analysis?]
```

**Example — Good:**
```
Context: We need auth for our API. Currently no auth, launching in 2 weeks.

Question: Should we use JWT or session-based auth?

Constraints:
- Node.js/Express backend, React frontend
- Must support mobile apps later
- Team has JWT experience but not session management

Perspectives: Security, scalability, implementation complexity

Expected: Recommendation with pros/cons for each approach
```

**Example — Bad:**
```
What auth should we use?
```

## Round Synthesis Template

When advancing rounds, synthesize previous responses to focus the next round:

```
## Round N Summary

### Common Themes
- [Points multiple workers agreed on]

### Key Insights
- [Worker-A]: [Their unique contribution]
- [Worker-B]: [Their unique contribution]

### Disagreements
- [Topic]: Worker-A says X, Worker-B says Y

### Open Questions
- [Questions raised but not answered]

---

## Round N+1 Focus

Given the above, please address:
1. [Specific question to resolve disagreement]
2. [Area needing more depth]
3. [New angle to consider based on insights]
```

## Closing Synthesis Template

When ending the party, synthesize the full discussion:

```
## Decision/Recommendation
[Clear statement of the conclusion]

## Supporting Arguments
- [Key point 1 with attribution]
- [Key point 2 with attribution]

## Dissenting Views
- [Any unresolved disagreements — important to capture]

## Action Items
- [ ] [Concrete next step + owner]
- [ ] [Concrete next step + owner]

## Open Questions (for future)
- [Questions that surfaced but weren't resolved]
```

---

## Key Principles

1. **Round-gated visibility** - Workers only see previous round responses after `party next`
2. **Hook-driven capture** - No special worker commands needed
3. **Leader controls pacing** - Only leader can advance rounds or end party
4. **Automatic timeout** - Sweep marks parties inactive after timeout with no responses
