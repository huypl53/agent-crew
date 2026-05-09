# Advisor Perspectives for Party Discussions

Structured discussions benefit from diverse viewpoints. Assign workers specific perspectives to avoid groupthink and ensure comprehensive coverage.

## The Four Advisors

### Systems Designer

**Focus:** Architecture, boundaries, interfaces, data flow

**Questions to drive analysis:**
- What are the system boundaries?
- How do components communicate?
- What contracts exist between services?
- Where does data flow, and what transformations occur?
- What are the integration points?

**Output emphasis:**
- Component diagrams (conceptual)
- Interface contracts
- Data flow descriptions
- Coupling/cohesion assessment

### Technology Strategist

**Focus:** Stack choices, patterns, ecosystem, team fit

**Questions to drive analysis:**
- What technologies solve this problem well?
- What patterns are industry-standard for this use case?
- Does the team have relevant experience?
- What's the ecosystem maturity (docs, community, tooling)?
- What's the learning curve vs. long-term benefit?

**Output emphasis:**
- Technology comparison matrix
- Pattern recommendations
- Ecosystem assessment
- Team capability alignment

### Scalability Consultant

**Focus:** Performance, reliability, growth trajectory

**Questions to drive analysis:**
- What are the expected load characteristics?
- Where are the bottlenecks likely to form?
- How does the solution scale horizontally/vertically?
- What's the failure mode under load?
- What monitoring/observability is needed?

**Output emphasis:**
- Capacity planning considerations
- Bottleneck identification
- Scaling strategy
- Performance requirements

### Risk Analyst

**Focus:** Trade-offs, failure modes, dependencies, security

**Questions to drive analysis:**
- What could go wrong?
- What are we trading off with this approach?
- What dependencies create risk?
- What's the blast radius of failure?
- What security considerations exist?

**Output emphasis:**
- Risk matrix (likelihood × impact)
- Trade-off analysis
- Dependency mapping
- Mitigation strategies

## Assignment Patterns

### Full Coverage (4 workers)
Assign one perspective per worker. Best for complex architectural decisions.

### Paired Perspectives (2 workers)
- Worker A: Systems Designer + Tech Strategist (solution-focused)
- Worker B: Scalability Consultant + Risk Analyst (validation-focused)

### Single Worker with Multiple Hats
Worker addresses all four perspectives sequentially in their response. Use when team size is limited.

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|--------------|---------|-----|
| Vague assignment | "Think about security" | Use specific perspective with guiding questions |
| Overlapping assignments | Two workers both doing risk analysis | Clear perspective boundaries |
| Missing perspective | No one assigned to scalability | Ensure all four covered |
| Perspective drift | Worker answers from wrong angle | Remind them of their assigned lens |

## Calibration Questions

Before starting, leader should verify:
1. Does each worker understand their assigned perspective?
2. Are the guiding questions clear?
3. Is there any overlap that needs resolution?
4. Is the expected output format understood?
