# Basic HTTP — curl and the official OpenAI SDK

The shortest path to "it works": no framework, just an HTTP client pointed
at DevBridge instead of `api.openai.com`.

## curl

```bash
./curl.sh
# or, if DevBridge is running on a different port:
DEVBRIDGE_URL=http://127.0.0.1:3002 ./curl.sh
```

Shows one non-streaming request and one streaming (SSE) request, both with
only `Content-Type` and `X-Session-Id` set.

## Official `openai` SDK

```bash
npm install
npm start
# or:
DEVBRIDGE_URL=http://127.0.0.1:3002 npm start
```

The whole integration is two constructor options:

```js
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'devbridge-does-not-check-this', // any non-empty string
  defaultHeaders: { 'X-Session-Id': 'examples-openai-sdk' },
})
```

`apiKey` can be any non-empty string — DevBridge has no credentials of its
own to check it against. The real authentication is the CLI's own
`/login` flow, completed once via the dashboard.
