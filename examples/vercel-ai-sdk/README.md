# Vercel AI SDK

```bash
npm install
npm start
# or:
DEVBRIDGE_URL=http://127.0.0.1:3002 npm start
```

Runs a non-streaming `generateText` call and a streaming `streamText` call
against DevBridge.

## The gotcha: don't use the bare `openai()` provider

Since AI SDK v5, the default provider helper from `@ai-sdk/openai`
(`openai('model-id')`) targets OpenAI's newer **Responses** API, even when
you point it at a custom `baseURL` — see
[vercel/ai#17944](https://github.com/vercel/ai/issues/17944). DevBridge
only ever speaks **Chat Completions**, so that combination silently talks
to the wrong shape of endpoint.

Use `createOpenAICompatible()` from `@ai-sdk/openai-compatible` instead —
it always speaks Chat Completions:

```js
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const devbridge = createOpenAICompatible({
  name: 'devbridge',
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'devbridge-does-not-check-this',
  headers: { 'X-Session-Id': 'examples-vercel-ai-sdk' },
})

const { text } = await generateText({
  model: devbridge.chatModel('sonnet'),
  prompt: 'Reply with exactly one word: OK',
})
```
