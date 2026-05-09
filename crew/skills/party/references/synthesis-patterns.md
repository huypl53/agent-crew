# Synthesis Patterns for Multi-Perspective Input

How leaders combine diverse worker responses into coherent outcomes.

## Core Synthesis Process

```
1. Extract   — Pull key points from each response
2. Cluster   — Group related points across workers
3. Identify  — Find agreements, disagreements, gaps
4. Weigh     — Consider confidence levels and expertise
5. Integrate — Form unified recommendation
6. Attribute — Credit sources, note dissent
```

## Extraction Techniques

### Key Point Extraction
From each response, extract:
- **Position** — What do they recommend?
- **Reasoning** — Why do they recommend it?
- **Evidence** — What supports their view?
- **Confidence** — How certain are they?
- **Caveats** — What conditions or exceptions?

### Signal vs. Noise
**Keep:**
- Concrete recommendations
- Specific trade-offs
- Novel perspectives
- Evidence-backed claims

**Filter:**
- Hedging language ("it depends", "maybe")
- Restated problem without solution
- Generic advice without context
- Repetition of known facts

## Clustering Patterns

### Theme Clustering
Group points by topic:
```
Performance Theme:
- Worker-A: "Use caching at API layer"
- Worker-C: "Database queries are the bottleneck"

Security Theme:
- Worker-B: "JWT tokens need rotation"
- Worker-D: "Input validation is missing"
```

### Position Clustering
Group by stance:
```
Pro-GraphQL:
- Worker-A: Type safety benefits
- Worker-C: Client flexibility

Pro-REST:
- Worker-B: Team familiarity
- Worker-D: Simpler debugging
```

## Disagreement Resolution

### Identify Disagreement Type

| Type | Description | Resolution |
|------|-------------|------------|
| **Factual** | Different beliefs about reality | Gather evidence, verify facts |
| **Values** | Different priorities | Make trade-off explicit, leader decides |
| **Scope** | Talking past each other | Clarify what each is addressing |
| **Incomplete** | Missing information | Request additional analysis |

### Resolution Strategies

**Factual disagreement:**
```
Worker-A says X scales to 10K QPS.
Worker-B says X only handles 1K QPS.
→ Request benchmark data or documentation.
```

**Values disagreement:**
```
Worker-A prioritizes developer experience.
Worker-B prioritizes runtime performance.
→ State which value takes precedence for this decision.
```

**Scope disagreement:**
```
Worker-A addresses short-term solution.
Worker-B addresses long-term architecture.
→ Clarify timeframe, may need both answers.
```

## Weighting Factors

Not all opinions are equal. Weight by:

| Factor | Higher Weight | Lower Weight |
|--------|---------------|--------------|
| **Expertise** | Assigned perspective matches topic | Outside their lane |
| **Evidence** | Backed by data/examples | Unsupported assertion |
| **Confidence** | High confidence stated | Low confidence / hedging |
| **Specificity** | Concrete recommendation | Vague guidance |

## Integration Templates

### Recommendation Synthesis
```
## Recommendation
[Clear statement of decision]

## Rationale
Based on [Worker-A]'s analysis of [X] and [Worker-B]'s assessment of [Y],
the recommended approach is [Z] because:
1. [Key supporting point]
2. [Key supporting point]

## Trade-offs Accepted
- [What we're giving up] in favor of [what we're gaining]

## Dissenting View
[Worker-C] recommended [alternative] due to [reason].
This was not adopted because [rationale].
```

### Options Synthesis
```
## Options Identified

### Option A: [Name]
- Advocated by: Worker-A, Worker-C
- Pros: [from their analysis]
- Cons: [from Risk Analyst]
- Confidence: High

### Option B: [Name]
- Advocated by: Worker-B
- Pros: [from their analysis]
- Cons: [from others' critique]
- Confidence: Medium

## Recommendation
Option A, because [synthesis of why it wins on balance]
```

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|--------------|---------|-----|
| **False balance** | Treating all views as equal weight | Acknowledge expertise differences |
| **Loudest voice** | Most verbose response wins | Focus on substance, not length |
| **Recency bias** | Last response disproportionately influences | Review all responses before synthesizing |
| **Confirmation bias** | Leader's prior view shapes synthesis | State leader opinion after synthesis |
| **Lost dissent** | Minority view not captured | Always document disagreements |

## Quality Checklist

Before finalizing synthesis:
- [ ] All worker perspectives represented?
- [ ] Agreements clearly stated?
- [ ] Disagreements explicitly captured?
- [ ] Trade-offs documented?
- [ ] Confidence levels noted?
- [ ] Action items concrete?
- [ ] Dissenting views preserved?
