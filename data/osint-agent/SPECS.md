## GLM alternatives for openAI API key, comptible format

glm-key: 1bf5f4ed20a546f195094ab157187d34.0WtNFOQakbe9Lba1

usage:
```
curl -X POST "https://api.z.ai/api/coding/paas/v4/chat/completions" \
-H "Content-Type: application/json" \
-H "Accept-Language: en-US,en" \
-H "Authorization: Bearer YOUR_API_KEY" \
-d '{
    "model": "glm-5.1",
    "messages": [
        {
            "role": "system",
            "content": "You are a helpful AI assistant."
        },
        {
            "role": "user",
            "content": "Hello, please introduce yourself."
        }
    ]
}'

```
- OpenAI client config:
```
API keys and clients

By default, the SDK uses the OPENAI_API_KEY environment variable for LLM requests and tracing. The key is resolved when the SDK first creates an OpenAI client (lazy initialization), so set the environment variable before your first model call. If you are unable to set that environment variable before your app starts, you can use the set_default_openai_key() function to set the key.

from agents import set_default_openai_key

set_default_openai_key("sk-...")

Alternatively, you can also configure an OpenAI client to be used. By default, the SDK creates an AsyncOpenAI instance, using the API key from the environment variable or the default key set above. You can change this by using the set_default_openai_client() function.

from openai import AsyncOpenAI
from agents import set_default_openai_client

custom_client = AsyncOpenAI(base_url="...", api_key="...")
set_default_openai_client(custom_client)

Finally, you can also customize the OpenAI API that is used. By default, we use the OpenAI Responses API. You can override this to use the Chat Completions API by using the set_default_openai_api() function.

from agents import set_default_openai_api

set_default_openai_api("chat_completions")


```

## Dependencies
- use context7 skill to search for documentation online.
- Python project in uv package management, remember to pin packages version. 
- Python: use Structlog for smooth logging for both CLI and file with rotation
- Python: use load-dotenv to load .env with over write
- Python: use pydantic settings to load variables then save in config of the project.
- I want to have postgreSQL with sql alchemy for openAI session and conversation history. So install postgreSQL in docker, save its connectin to .env for later uses
- Install langfuse in docker as well. Save it connection to .env. Add tracing with langfuse + open AI. Here is sample of .env with them:
```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com  # or https://us.cloud.langfuse.com, or self-hosted URL
```


---

This app is leveraging agent to do searching over relation data. User can ask arbitrary questions about the data: who is Foo? => agent search for name Foo; What is relation of Foo to Bar? agent search for Foo and Bar then the relation between them if there are... Imaing the data is from graph database with complicated relation and thousands of nodes with limit: the input data to graph database is untidied, so it can contains polutated data: e.g: hundreds nodes with same name and similar properties, agent search, tools return some, then agent must filter the results to answer the user correctly.

## Tasks
- In /Users/lee/code/freelance/26-osint-agent/data/nodes.csv there are nodes, in /Users/lee/code/freelance/26-osint-agent/data/relationships.csv there are relation between them. They were extracted from the osint data. First I need you to spawn reasons to learn about the data and I propose API to to have agent to do the task searching => Then ask them to propose SCENARIOS THE REAL USER MIGHT WANT TO SEARCH FOR
- Based on the listed scenarios, list our the related functions that help agent do searching. Create those functions
- Register those functions to OpenAI agents
- our agents system are: 
    1. orchestrator agent: chat directly with user, delegate tasks to searcher. Knowing the conversation history so next user queation link to the current context, agent must know that to delegate to searching agent. This agent is stateful with session stored
    2. searching agent: has tools, do searcching, return outcome to orchestrator agent. This agent does not talk directly with user, just do searching. This agent is stateless, just do searching

- Agent talk, reason, think process should be stream, so user doesn't have to wait for long time.
- implement streamlit app with conversation history and tool calling from agents, like modern chat app
- We have data in postres, so save user session and history to it, load old ones to the streamlit app
---
Read and update this file if having changes
