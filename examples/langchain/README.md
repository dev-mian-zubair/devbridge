# LangChain

```bash
npm install
npm start
# or:
DEVBRIDGE_URL=http://127.0.0.1:3002 npm start
```

Runs a full tool-calling round trip, then a streaming call, against
DevBridge.

## Pointing `ChatOpenAI` at DevBridge

```js
import { ChatOpenAI } from '@langchain/openai'

const model = new ChatOpenAI({
  model: 'sonnet',
  apiKey: 'devbridge-does-not-check-this', // any non-empty string
  configuration: {
    baseURL: 'http://127.0.0.1:3000/v1',
    defaultHeaders: { 'X-Session-Id': 'examples-langchain' },
  },
})
```

## Tool calling is real, not simulated

DevBridge implements OpenAI-style function calling as a genuine
client-executes contract: `model.bindTools([...])` makes the model propose
`tool_calls`, this example's code actually runs `get_weather`, and the
result is sent back as a `ToolMessage` in a follow-up call — exactly the
loop you'd run against the real OpenAI API. The underlying CLI's own
native tools (file access, shell execution) stay sandboxed the whole time;
this is a separate mechanism (a per-request MCP server reporting your
tool's JSON Schema) from that sandbox, and isn't affected by it.
