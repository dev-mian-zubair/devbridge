# CrewAI (Python)

```bash
pip install -r requirements.txt
python3 main.py
# or:
DEVBRIDGE_URL=http://127.0.0.1:3002 python3 main.py
```

Runs a one-agent, one-task crew against DevBridge and prints the result.

## The gotcha: the model string needs a provider prefix

CrewAI's `LLM` class routes every call through
[litellm](https://github.com/BerriAI/litellm), which identifies which
backend to talk to from a `"<provider>/<model>"` string — a bare `"sonnet"`
makes litellm guess the wrong provider entirely. Prefix it with `openai/`
so litellm treats DevBridge as a generic OpenAI-compatible Chat Completions
endpoint:

```python
from crewai import LLM

llm = LLM(
    model="openai/sonnet",  # not just "sonnet"
    base_url="http://127.0.0.1:3000/v1",
    api_key="devbridge-does-not-check-this",  # any non-empty string
    extra_headers={"X-Session-Id": "examples-crewai"},
)
```

`extra_headers` is passed straight through to litellm's own HTTP call —
this is how `X-Session-Id` reaches DevBridge.

You may also see a one-time warning that CrewAI doesn't know the model's
real context window and is assuming 8,192 tokens. That's informational,
not an error — litellm has no built-in entry for a custom model name like
`"sonnet"`. Silence it by passing `context_window_size=<tokens>` to `LLM(...)`
if you want an accurate value.
