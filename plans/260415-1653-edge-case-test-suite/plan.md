# Edge Case Test Suite for Agent Communication

**Status:** In Progress  
**Created:** 2026-04-15  
**Priority:** High  
**Effort:** Medium (2-3 hours)

---

## Overview

Implement 17 edge case tests in isolated tmux socket environment to verify agent communication reliability under failure conditions.

**Brainstorm:** `plans/reports/brainstorm-260415-1653-edge-case-test-suite.md`

---

## Phases

| Phase | File | Status | Description |
|-------|------|--------|-------------|
| 1 | `phase-01-test-harness.md` | Pending | Isolated tmux socket harness |
| 2 | `phase-02-mock-agent.md` | Pending | Controllable mock agent script |
| 3 | `phase-03-delivery-tests.md` | Pending | E1-E5: Delivery failure tests |
| 4 | `phase-04-status-tests.md` | Pending | E6-E8: Status detection tests |
| 5 | `phase-05-queue-tests.md` | Pending | E9-E11: Queue/polling tests |
| 6 | `phase-06-verification-tests.md` | Pending | E12-E13: Sender verification tests |
| 7 | `phase-07-integration-tests.md` | Pending | E14-E17: Integration flow tests |

---

## Files to Create

```
crew/test/
├── uat-edge-cases.ts           # Main test runner (17 tests)
├── fixtures/
│   └── mock-agent.sh           # Controllable mock agent
└── lib/
    └── edge-test-harness.ts    # Isolated tmux socket utilities
```

---

## Success Criteria

- [ ] All 17 edge cases pass
- [ ] Tests run in <60s total
- [ ] Zero interference with user's real tmux session
- [ ] Clear failure messages with context
- [ ] Exit code 1 on any failure

---

## Dependencies

- Builds on existing `crew/test/helpers.ts` patterns
- Uses `crew/src/tmux/index.ts` delivery code
- Uses `crew/src/delivery/pane-queue.ts` polling logic
