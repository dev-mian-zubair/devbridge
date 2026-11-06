// LangChain's ChatOpenAI, pointed at DevBridge, with real tool calling.
//
// DevBridge implements OpenAI-style function calling as a genuine
// client-executes contract: the model proposes `tool_calls`, this script
// runs the real function, and the result goes back in a follow-up call —
// exactly the LangChain tool-calling loop you'd run against the real API.
import { ChatOpenAI } from '@langchain/openai'
import { tool } from '@langchain/core/tools'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { z } from 'zod'

const model = new ChatOpenAI({
  model: 'sonnet',
  apiKey: 'devbridge-does-not-check-this',
  configuration: {
    baseURL: `${process.env.DEVBRIDGE_URL ?? 'http://127.0.0.1:3000'}/v1`,
    defaultHeaders: { 'X-Session-Id': 'examples-langchain' },
  },
})

const getWeather = tool(
  async ({ location }) => `It's sunny and 22C in ${location}.`,
  {
    name: 'get_weather',
    description: 'Get the current weather for a location.',
    schema: z.object({ location: z.string() }),
  },
)

const modelWithTools = model.bindTools([getWeather])

console.log('--- tool calling ---')
const messages = [new HumanMessage('What is the weather in Berlin? Use the tool.')]
const response = await modelWithTools.invoke(messages)
messages.push(response)

for (const call of response.tool_calls ?? []) {
  console.log('model requested tool call:', call.name, call.args)
  const result = await getWeather.invoke(call.args)
  messages.push(new ToolMessage({ content: result, tool_call_id: call.id }))
}

const final = await modelWithTools.invoke(messages)
console.log('final answer:', final.content)

console.log('\n--- streaming ---')
const stream = await model.stream('Count from 1 to 5, one number per line.')
for await (const chunk of stream) {
  process.stdout.write(chunk.content)
}
console.log()
