"""deepagents, pointed at DevBridge instead of a real OpenAI/Anthropic key.

The gotcha: deepagents' `model` argument accepts a plain string like
"openai:gpt-4o", but that shorthand always builds a client against the real
OpenAI API and ignores any base_url set elsewhere. Pass a pre-built
ChatOpenAI instance instead, with base_url pointed at DevBridge, and it
behaves exactly as it would against the real API.
"""
import os

from deepagents import create_deep_agent
from langchain_openai import ChatOpenAI

DEVBRIDGE_URL = os.environ.get("DEVBRIDGE_URL", "http://127.0.0.1:3000")

model = ChatOpenAI(
    base_url=f"{DEVBRIDGE_URL}/v1",
    api_key="devbridge-does-not-check-this",
    model="sonnet",
    default_headers={"X-Session-Id": "examples-deepagents"},
)

agent = create_deep_agent(
    model=model,
    tools=[],
    system_prompt="You are a terse assistant. Answer in one short sentence.",
)

result = agent.invoke({"messages": [{"role": "user", "content": "What is 2 + 2?"}]})
print("assistant said:", result["messages"][-1].content)
