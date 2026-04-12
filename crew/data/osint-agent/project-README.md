# OSINT Agent

An OSINT investigation assistant that lets users query relational data (people, organizations, events) through a conversational AI interface. Two agents (orchestrator + searcher) work together using the OpenAI Agents SDK with bidirectional handoffs. Streamlit provides the chat UI with streaming and tool visibility.

## Prerequisites

- Python 3.13+
- [uv](https://docs.astral.sh/uv/) package manager
- Docker & Docker Compose

## Setup

```bash
# 1. Install dependencies
uv sync

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start infrastructure (PostgreSQL + Langfuse)
docker compose up -d

# 4. Initialize database and load data
python -m src.db.init_db

# 5. Launch the app
streamlit run src/app.py
```

## Architecture

```
User ←→ Streamlit UI
              ↕
        Orchestrator Agent (user-facing, streams responses)
              ↕  bidirectional handoff
        Searcher Agent (tool_choice="required", no text generation)
              ↕
        Search Tools (7 tools)
              ↕
        PostgreSQL (nodes, relationships, sessions, messages)
```

The Orchestrator handles conversation and delegates search tasks. The Searcher executes tools and always hands back — it never generates user-facing text. See [docs/architecture.md](docs/architecture.md) for details.

## Tech Stack

- **LLM:** GLM-5.1 via OpenAI-compatible API, OpenAI Agents SDK
- **UI:** Streamlit with streaming chat interface
- **Database:** PostgreSQL 16 (async via SQLAlchemy + asyncpg)
- **Tracing:** Langfuse (optional, OpenAI integration)
- **Config:** pydantic-settings + python-dotenv
- **Logging:** structlog (console + rotating file)
- **Infrastructure:** Docker Compose (Postgres, Langfuse)
- **Package manager:** uv

## Data Model

- **Nodes:** Person, Organization, Event entities extracted from OSINT documents
- **Relationships:** `co_occurred` links between entities appearing in the same document
- **Grouping:** `row_id` ties nodes back to their source document

## Project Structure

```
src/
├── config.py              # pydantic-settings config
├── logging.py             # structlog setup
├── agents/
│   ├── client.py          # AsyncOpenAI client init + Langfuse tracing
│   ├── orchestrator.py    # User-facing orchestrator agent
│   ├── searcher.py        # Search-only agent with tool_choice="required"
│   ├── runner.py          # Streaming runner with UI-friendly events
│   ├── title_generator.py # Session title generation
│   └── tracing.py         # Langfuse OpenAI integration wrapper
├── db/
│   ├── models.py          # SQLAlchemy models (Node, Relationship, Session, Message)
│   ├── engine.py          # Async engine + session factory
│   ├── loader.py          # CSV data loader
│   └── init_db.py         # DB initialization script
└── tools/
    └── search.py          # 7 search tools for querying OSINT data
```

## Entity Extraction (Preprocessing)

The `extract_entities.py` script processes raw OSINT CSV data into `nodes.csv` and `relationships.csv`. This is a preprocessing step — run it only when source data changes.

```bash
python extract_entities.py
```
