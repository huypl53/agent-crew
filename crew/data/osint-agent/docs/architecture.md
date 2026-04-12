# Architecture

## System Overview

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│  Streamlit   │     │               Agent Layer                    │
│  Chat UI     │◄───►│  Orchestrator ◄──handoff──► Searcher        │
│  (streaming) │     │  (user-facing)              (tools only)     │
└─────────────┘     └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────►▼◄──────────────────┐
                    │            Search Tools (7)            │
                    └──────────────────┬────────────────────┘
                                       │
                    ┌──────────────────►▼◄──────────────────┐
                    │          PostgreSQL (Docker)           │
                    │  nodes | relationships | sessions | messages │
                    └───────────────────────────────────────┘

                    ┌───────────────────────────────────────┐
                    │         Langfuse (Docker, optional)    │
                    │         LLM call tracing               │
                    └───────────────────────────────────────┘
```

## Agent Architecture

Two agents with bidirectional handoff using the OpenAI Agents SDK.

### Orchestrator Agent (`src/agents/orchestrator.py`)

- **Role:** User-facing, manages conversation context
- **Behavior:** Understands OSINT domain, delegates search to Searcher, synthesizes results into clear answers, asks follow-up questions for disambiguation
- **Handoffs:** Forward to Searcher
- **Streaming:** Yes — tokens stream to the user

### Searcher Agent (`src/agents/searcher.py`)

- **Role:** Silent backend worker, executes search tools only
- **Behavior:** Calls tools, then MUST hand back to Orchestrator with findings. Never generates user-facing text.
- **Handoffs:** Return to Orchestrator
- **Tools:** All 7 search tools
- **Key setting:** `model_settings=ModelSettings(tool_choice="required")`

### Critical Insight: Return Handoff with GLM

GLM (glm-5.1) does not reliably call the return handoff (`transfer_to_orchestrator`) without enforcement. The fix requires **both**:

1. **`tool_choice="required"`** on the Searcher's ModelSettings — forces the LLM to always emit a tool call rather than generating text
2. **Explicit system prompt** — "MUST call transfer_to_orchestrator", "NEVER generate text for the user"

The SDK's `reset_tool_choice=True` (default) switches back to `auto` after tool execution, allowing the Searcher to call `transfer_to_orchestrator` on the follow-up turn. Without `tool_choice="required"`, GLM generates a text response instead of handing back.

Validated in `tests/test_glm_handoff.py`.

### Data Flow

```
1. User types question in Streamlit
2. Orchestrator receives message + conversation history
3. Orchestrator reasons, decides to delegate → handoff to Searcher
4. Searcher calls search tools (1+ tool calls)
5. Tools query PostgreSQL, return results
6. Searcher hands back to Orchestrator with findings
7. Orchestrator synthesizes results → streams answer to user
8. Title generation fires after first exchange (standalone LLM call)
```

### GLM API Integration

- Client: `AsyncOpenAI(base_url="https://api.z.ai/api/coding/paas/v4")`
- Compatibility: `set_default_openai_api("chat_completions")`
- Model: `glm-5.1`

## GLM Compatibility Notes

GLM (glm-5.1) is OpenAI-API-compatible but has several quirks that required workarounds:

### 1. "null" String Parameters

GLM sends the literal string `"null"` instead of JSON `null` for optional/unset function call parameters. All tool functions must sanitize inputs by converting `"null"` strings to Python `None`. See the `_clean_null()` helper in `src/tools/search.py`.

### 2. SDK Built-in Tracing Incompatible

The OpenAI Agents SDK's built-in tracing POSTs telemetry to `api.openai.com`, which rejects non-OpenAI API keys with a 401 error. Must call `set_tracing_disabled(True)` when using GLM as the provider. See `src/agents/client.py`.

### 3. Handoff Requires `tool_choice="required"`

GLM doesn't reliably call the return handoff function (`transfer_to_orchestrator`) without `ModelSettings(tool_choice="required")` on the Searcher agent. Without this, GLM generates text directly instead of handing back. The combination of `tool_choice="required"` + an explicit system prompt ("MUST call transfer_to_orchestrator") ensures reliable bidirectional handoffs. Validated in `tests/test_glm_handoff.py`.

### 4. chat_completions Mode Required

GLM doesn't support the OpenAI Responses API. Must use `set_default_openai_api("chat_completions")` to force the agents SDK to use the Chat Completions API instead.

## Data Model

### Node Types

| Label | Description | Example Properties |
|-------|-------------|-------------------|
| `Person` | People/targets | name, role, position |
| `Organization` | Companies, agencies | name, address, profession |
| `Event` | Events, incidents | name, date |

### Relationships

- **Type:** `co_occurred` — two entities appear in the same source document
- **Grouping:** `row_id` links nodes to their source document (UUID)
- **Data is untidied** — duplicates and similar nodes expected; the agent handles disambiguation via reasoning

### Database Tables

| Table | Purpose |
|-------|---------|
| `nodes` | Entity and event nodes (from nodes.csv) |
| `relationships` | co_occurred links between nodes (from relationships.csv) |
| `sessions` | Chat session ID, title, timestamps |
| `messages` | session_id (FK), role, content, tool_calls (JSON), timestamp |

## Search Tools (`src/tools/search.py`)

| Tool | Purpose |
|------|---------|
| `search_nodes` | Find nodes by name and/or property filters |
| `search_relationships` | Search by relationship type, source, or target |
| `get_node_relationships` | Get all relationships for a given node |
| `get_co_occurred_nodes` | Get nodes that co-occurred with a given node |
| `find_connections` | Find shared connections between two nodes |
| `get_node_details` | Full detail view of any node with all properties |
| `get_document_group` | Get all nodes from the same source document (by row_id) |

All tools query PostgreSQL via async SQLAlchemy. They are mock implementations over CSV-loaded data — future real implementations will replace internals while keeping the same interface.

## Infrastructure

### Docker Compose (`docker-compose.yml`)

- **PostgreSQL 16** — port 5432, stores OSINT data + conversation history
- **Langfuse** — port 3000, LLM tracing (uses same Postgres instance, separate `langfuse` DB)
- **Persistent volumes** for both services

### Configuration (`src/config.py`)

- `python-dotenv` loads `.env` with override
- `pydantic-settings` BaseSettings validates and types all config
- Langfuse settings optional (`str | None = None`) — tracing disabled when unset

### Logging (`src/logging.py`)

- `structlog` with dual output:
  - Console: pretty-printed (ConsoleRenderer)
  - File: JSON format, rotating (10MB, 5 backups) at `logs/osint_agent.log`

### Tracing (`src/agents/tracing.py`)

- Wraps AsyncOpenAI client with Langfuse OpenAI integration
- Gracefully degrades — if keys not set or import fails, returns unwrapped client
- Connected via `src/agents/client.py` during initialization

## Key Files

| File | Purpose |
|------|---------|
| `src/config.py` | Pydantic settings, loads .env |
| `src/logging.py` | structlog config (console + file) |
| `src/agents/client.py` | OpenAI client init + Langfuse tracing |
| `src/agents/orchestrator.py` | Orchestrator agent definition |
| `src/agents/searcher.py` | Searcher agent with tool_choice="required" |
| `src/agents/runner.py` | Streaming runner producing UI-friendly events |
| `src/agents/title_generator.py` | Session title via standalone LLM call |
| `src/agents/tracing.py` | Langfuse OpenAI wrapper |
| `src/db/models.py` | SQLAlchemy models (Node, Relationship, Session, Message) |
| `src/db/engine.py` | Async engine + session factory |
| `src/db/loader.py` | CSV data loading logic |
| `src/db/init_db.py` | DB init script (`python -m src.db.init_db`) |
| `src/tools/search.py` | 7 search tools querying PostgreSQL |
| `tests/test_glm_handoff.py` | GLM handoff validation test |
| `extract_entities.py` | Preprocessing: CSV → nodes.csv + relationships.csv |
