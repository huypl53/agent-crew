# OSINT Agent App — Implementation Plan

## Prerequisites
- Design spec: `docs/superpowers/specs/2026-04-11-osint-agent-design.md`
- Infrastructure: docker-compose.yml, src/config.py, src/logging.py (done)
- GLM handoff validation: tests/test_glm_handoff.py (pending execution)

## Phase 0: Foundation (DONE)
- [x] Design spec written and approved
- [x] Docker Compose (Postgres + Langfuse)
- [x] Config module (pydantic-settings + dotenv)
- [x] Logging module (structlog)
- [x] Data exploration report
- [x] SDK research report
- [x] GLM handoff test script created
- [ ] GLM handoff test EXECUTED — go/no-go gate

## Phase 1: Data Layer
- [ ] SQLAlchemy models: Node, Relationship, Session, Message (src/db/models.py)
- [ ] Async engine + session factory (src/db/engine.py)
- [ ] CSV data loader — idempotent, parses JSON properties (src/db/loader.py)
- [ ] DB init script — create tables, load data (src/db/init_db.py)
- [ ] Verify: load CSV data into Postgres, query works

## Phase 2: Search Tools
- [ ] `search_nodes` — ILIKE name search, label filter, JSON property filter, pagination
- [ ] `search_relationships` — filter by source/target/type
- [ ] `get_node_relationships` — all relationships for a node with direction filter
- [ ] `get_co_occurred_nodes` — nodes that co-occurred with given node, label filter
- [ ] `find_connections` — check if two nodes share row_id co-occurrence groups
- [ ] `get_node_details` — full node info + direct relationships
- [ ] `get_document_group` — all nodes from same source document (row_id)
- [ ] All tools in `src/tools/` package, each decorated with `@function_tool`
- [ ] Tool tests against loaded Postgres data

## Phase 3: Agent System
- [ ] Searcher agent definition — system prompt, all 7 tools, handoff back to orchestrator (src/agents/searcher.py)
- [ ] Orchestrator agent definition — system prompt, handoff to searcher, conversation-aware (src/agents/orchestrator.py)
- [ ] Bidirectional handoff setup — circular reference pattern
- [ ] GLM client configuration — AsyncOpenAI with GLM base_url, chat_completions mode
- [ ] Session title generation — standalone LLM call (src/agents/title_generator.py)
- [ ] Langfuse tracing wrapper (src/agents/tracing.py)
- [ ] Agent runner — run_streamed with event processing (src/agents/runner.py)

## Phase 4: Streamlit App
- [ ] Chat UI — message display with streaming (src/app.py or app/main.py)
- [ ] Tool call rendering — expandable blocks showing tool name, args, results
- [ ] Session sidebar — list past sessions, "New Chat" button, sorted by recent
- [ ] Session persistence — save/load messages to Postgres
- [ ] Session title — auto-generate after first exchange, update sidebar
- [ ] Streaming integration — connect agent runner events to Streamlit chat

## Phase 5: Integration & Polish
- [ ] End-to-end test: user question → orchestrator → searcher → tools → answer
- [ ] Session persistence test: create, reload, continue conversation
- [ ] Streaming verification: no idle gaps in UI
- [ ] Error handling: agent failures, DB connection issues, GLM API errors

## Build Order & Dependencies
```
Phase 0 (done) → Phase 1 (data layer) → Phase 2 (search tools, needs DB)
                                       → Phase 3 (agents, needs tools + GLM validation)
                                       → Phase 4 (Streamlit, needs agents)
                                       → Phase 5 (integration)
```

Phase 2 and Phase 3 can partially overlap — agent definitions can start while tools are being built, but agent testing needs tools complete.

## Fallback Plan
If GLM handoff test FAILS:
- Fall back to Approach A1: searcher as internal tool/function call
- Orchestrator stays as SDK Agent
- Searcher runs as a nested agent inside a tool function
- Requires custom streaming plumbing for inner agent events
