// The official `openai` SDK, pointed at DevBridge instead of api.openai.com.
//
// Two settings make this work:
//   - baseURL: DevBridge's /v1 root.
//   - apiKey: any non-empty string. DevBridge has no credentials of its own
//     to check this against — the real auth is the CLI's own /login flow,
//     already completed once via the dashboard.
//
// X-Session-Id is sent as a default header so every call this client makes
// carries it automatically, without touching the OpenAI-shaped request body.
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: `${process.env.DEVBRIDGE_URL ?? 'http://127.0.0.1:3000'}/v1`,
  apiKey: 'devbridge-does-not-check-this',
  defaultHeaders: { 'X-Session-Id': 'examples-openai-sdk' },
})

console.log('--- non-streaming ---')
const completion = await client.chat.completions.create({
  model: 'sonnet',
  messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
})
console.log('assistant said:', completion.choices[0].message.content)
console.log('usage:', completion.usage)

console.log('\n--- streaming ---')
const stream = await client.chat.completions.create({
  model: 'sonnet',
  stream: true,
  messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
})
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content
  if (delta) process.stdout.write(delta)
}
console.log()
