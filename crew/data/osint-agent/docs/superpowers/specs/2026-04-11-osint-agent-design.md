# OSINT Agent App — Design Spec

## Overview
An OSINT investigation app that lets users query relational data (entities and events) through a conversational AI interface. Two agents (orchestrator + searcher) work together using OpenAI Agents SDK with bidirectional handoffs. Streamlit provides the chat UI with streaming and tool visibility.

## Data Model
- **636 total nodes** across 3 label types:
  - **Person** (237 nodes) — properties: `name` (98.7%), `role` (67.1%), `job` (58.6%), `action` (50.2%), `position` (32.1%), plus sparse: `date_of_birth`, `ranking`, `addresss`, `age`
  - **Organization** (226 nodes) — properties: `name` (100%), `profession` (89.4%), `addresss` (23.9%), `action` (3.1%)
  - **Event** (173 nodes) — properties: `name` (100%), `summary` (96.5%)
- **Properties** are stored as a JSON blob (`properties` column), with different keys per label type
- **Note:** `addresss` has a triple-s typo in the source data — kept as-is
- **Language:** All data is Vietnamese (OSINT from Vietnamese sources)
- **`row_id`:** UUID grouping nodes extracted from the same source document (88 unique source documents)
- **Relationships:** 2,436 rows, **all `co_occurred` type** — nodes from the same source document form co-occurrence cliques (3 to 171 relationships per document group)
- **Linking:** `source_node_id` and `target_node_id` reference `node_id` in nodes — all 548 unique IDs match
- **Data is untidied** — duplicates and similar nodes expected. Agent handles disambiguation via reasoning. 3 Person nodes have empty names/properties (node_ids: 134, 320, 392).

## Search Tools (Mock Implementations)
These tools query Postgres (CSV data loaded into DB). Future real implementations will replace the internals while keeping the same interface.

| # | Tool | Input | Purpose |
|---|------|-------|---------|
| 1 | `search_nodes` | `name: str?, label: str? (Person/Organization/Event), properties: dict?, limit: int=20, offset: int=0` | Unified search across all node types |
| 2 | `search_relationships` | `source_id: str?, target_id: str?, relationship_type: str?, limit: int=20` | Search relationships (currently all co_occurred) |
| 3 | `get_node_relationships` | `node_id: str, direction: str? (outgoing/incoming/both), limit: int=20` | Get all relationships for a node |
| 4 | `get_co_occurred_nodes` | `node_id: str, label: str?, limit: int=20` | Get nodes that co-occurred with given node, optionally filtered by label |
| 5 | `find_connections` | `node_id_1: str, node_id_2: str` | Find if two nodes share co-occurrence groups (same row_id) |
| 6 | `get_node_details` | `node_id: str` | Full details of a node with all properties and direct relationships |
| 7 | `get_document_group` | `row_id: str` | Get all nodes extracted from the same source document |

## Agent Architecture (OpenAI Agents SDK — A2 Handoff with Return)

### Orchestrator Agent
- **Role:** User-facing, manages conversation context, delegates search tasks
- **System prompt:** Understands OSINT domain, knows when to search vs answer from context, synthesizes search results into clear answers, handles disambiguation by asking follow-up questions
- **Has:** Handoff to Searcher
- **Stateful:** Conversation history stored in PostgreSQL per session
- **Streaming:** Yes, tokens stream to user

### Searcher Agent
- **Role:** Silent backend worker, executes search tools, returns structured findings
- **System prompt:** "Use your tools to find the requested information. Do NOT generate text for the user. When your search is complete, hand back to the orchestrator with a structured summary of your findings."
- **Has:** All 7 search tools + Handoff back to Orchestrator
- **Stateless:** No memory between invocations
- **Streaming:** Tool call events visible to user (expandable blocks)

### Flow
```
User asks question
  → Orchestrator streams reasoning
  → Orchestrator hands off to Searcher
  → Searcher calls tools (streamed as tool events)
  → Searcher hands back with findings
  → Orchestrator streams final answer to user
```

### GLM API Integration
- `AsyncOpenAI(base_url="https://api.z.ai/api/coding/paas/v4", api_key=glm_key)`
- `set_default_openai_api("chat_completions")` for compatibility
- Model: `glm-5.1`

### Session Title Generation
- Standalone single LLM call (NOT part of orchestrator agent)
- Fires after first user message, saves title to Postgres
- Simple prompt: "Generate a short title for this conversation" + user's first message

## Data Layer & Infrastructure

### PostgreSQL (Docker)
Stores OSINT data and conversation history.

| Table | Purpose |
|-------|---------|
| `nodes` | Entity and event nodes from nodes.csv |
| `relationships` | Relationships from relationships.csv |
| `sessions` | Session ID, title, created_at, updated_at |
| `messages` | session_id (FK), role, content, tool_calls (JSON), timestamp |

### Langfuse (Docker)
- Tracing for all LLM calls (orchestrator, searcher, title generation)
- Connected via OpenAI integration — wraps the AsyncOpenAI client

### Config Stack
- `.env` file with all secrets (Postgres, Langfuse, GLM API key)
- `python-dotenv` loads `.env` with override
- `pydantic-settings` validates and exposes config as typed settings object

### Logging
- `structlog` for both CLI and file output with rotation

## Streamlit App

### Layout
- **Sidebar:** Past sessions list (from Postgres), "New Chat" button, sorted by most recent
- **Main area:** Chat interface with message history

### Chat Display
- User messages: right-aligned
- Assistant messages: left-aligned, streamed token by token
- Tool calls: expandable blocks (tool name, args, results), collapsed by default
- Status indicator ("Searching...") during searcher handoff

### Session Flow
1. User clicks "New Chat" or selects existing session from sidebar
2. Existing session → load message history from Postgres
3. User types message → sent to orchestrator agent
4. Response streams back in real-time
5. Tool events rendered as expandable blocks inline
6. After first exchange → fire title generation → update sidebar

### State Management
- `st.session_state` holds current session ID and message list
- Each message persisted to Postgres `messages` table
- Tool calls stored as JSON in the message record

## Dependencies
- **Package manager:** uv (pinned versions)
- **LLM:** openai-agents SDK, AsyncOpenAI
- **Database:** SQLAlchemy + asyncpg
- **UI:** Streamlit
- **Config:** pydantic-settings, python-dotenv
- **Logging:** structlog
- **Tracing:** langfuse
- **Infrastructure:** Docker (PostgreSQL, Langfuse)
