# deepagents (Python)

```bash
pip install -r requirements.txt
python3 main.py
# or:
DEVBRIDGE_URL=http://127.0.0.1:3002 python3 main.py
```

## The gotcha: don't use the `"provider:model"` string shorthand

deepagents' `create_deep_agent(model=...)` accepts a plain string like
`"openai:gpt-4o"` as a convenience, but that shorthand always builds its
own client against the real OpenAI API using whatever `OPENAI_API_KEY` is
in your environment — it has no way to take a custom `base_url`, so it
silently ignores DevBridge entirely.

Pass a pre-built `ChatOpenAI` instance instead, with `base_url` pointed at
DevBridge:

```python
from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent

model = ChatOpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="devbridge-does-not-check-this",  # any non-empty string
    model="sonnet",
    default_headers={"X-Session-Id": "examples-deepagents"},
)

agent = create_deep_agent(model=model, tools=[])
result = agent.invoke({"messages": [{"role": "user", "content": "What is 2 + 2?"}]})
```

This example passes `tools=[]` and a short `system_prompt` to keep the
agent terse and dependency-free — a real deepagents app would pass actual
tools the same way, and they'd flow through DevBridge's tool-calling
support exactly like the [LangChain example](../langchain)'s does.
