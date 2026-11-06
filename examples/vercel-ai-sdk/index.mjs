// Vercel AI SDK, pointed at DevBridge.
//
// The gotcha: the bare default provider helper (`openai('model-id')` from
// the `@ai-sdk/openai` package) targets OpenAI's newer Responses API even
// when you give it a custom baseURL — see
// https://github.com/vercel/ai/issues/17944. DevBridge only ever speaks
// Chat Completions, so use `createOpenAICompatible()` instead, which always
// does.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, streamText } from 'ai'

const devbridge = createOpenAICompatible({
  name: 'devbridge',
  baseURL: `${process.env.DEVBRIDGE_URL ?? 'http://127.0.0.1:3000'}/v1`,
  apiKey: 'devbridge-does-not-check-this',
  headers: { 'X-Session-Id': 'examples-vercel-ai-sdk' },
})

console.log('--- generateText ---')
const { text, usage } = await generateText({
  model: devbridge.chatModel('sonnet'),
  prompt: 'Reply with exactly one word: OK',
})
console.log('assistant said:', text)
console.log('usage:', usage)

console.log('\n--- streamText ---')
const { textStream } = streamText({
  model: devbridge.chatModel('sonnet'),
  prompt: 'Count from 1 to 5, one number per line.',
})
for await (const chunk of textStream) {
  process.stdout.write(chunk)
}
console.log()
