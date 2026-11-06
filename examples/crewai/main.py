"""CrewAI, pointed at DevBridge via its litellm-backed LLM class.

The gotcha: CrewAI's LLM class routes every call through litellm, which
identifies a backend by a "<provider>/<model>" string, not a bare model
name — "sonnet" alone makes litellm guess the wrong provider. Use
"openai/sonnet" so litellm treats DevBridge as an OpenAI-compatible Chat
Completions endpoint; base_url, api_key, and extra_headers are then passed
straight through to the actual HTTP call.
"""
import os

from crewai import Agent, Crew, LLM, Task

DEVBRIDGE_URL = os.environ.get("DEVBRIDGE_URL", "http://127.0.0.1:3000")

llm = LLM(
    model="openai/sonnet",
    base_url=f"{DEVBRIDGE_URL}/v1",
    api_key="devbridge-does-not-check-this",  # any non-empty string
    extra_headers={"X-Session-Id": "examples-crewai"},
)

writer = Agent(
    role="Terse writer",
    goal="Answer questions in exactly one short sentence.",
    backstory="You never elaborate.",
    llm=llm,
    verbose=False,
)

task = Task(
    description="What is 2 + 2?",
    expected_output="One short sentence with the answer.",
    agent=writer,
)

crew = Crew(agents=[writer], tasks=[task], verbose=False)
result = crew.kickoff()
print("result:", result)
