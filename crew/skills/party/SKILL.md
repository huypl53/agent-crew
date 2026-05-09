---
name: crew:party
description: Run structured multi-worker discussions with round-gated visibility
---

# Party Mode

Party mode enables structured group discussions where a leader broadcasts a topic to all workers, collects their responses, and controls when workers see each other's replies.

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

## Key Principles

1. **Round-gated visibility** - Workers only see previous round responses after `party next`
2. **Hook-driven capture** - No special worker commands needed
3. **Leader controls pacing** - Only leader can advance rounds or end party
4. **Automatic timeout** - Sweep marks parties inactive after timeout with no responses
