import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

export async function nativeContext(directory, respond, options = {}) {
  const contractError = 'Mock responder must return an iterable; use an async generator for asynchronous responses.'
  if (respond.constructor.name === 'AsyncFunction') throw new TypeError(contractError)
  const context = new Context()
  try {
    await context.plugin(SessionStore)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(AgentRegistry)
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'native' })
    await context.plugin(LlmRuntime)
    if (options.persistence !== false) await context.plugin(options.persistence ?? JsonlPersistence,
      options.persistenceConfig ?? { root: directory, compression: 'none' })
    await context.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    class MockAdapter extends LlmAdapter {
      async *stream(options) {
        const response = respond(options)
        if (!response || typeof response[Symbol.iterator] !== 'function' && typeof response[Symbol.asyncIterator] !== 'function') throw new TypeError(contractError)
        yield* response
      }
    }
    context.llm.registerAdapter(['mock'], new MockAdapter())
    return context
  } catch (error) { await context.fiber.dispose(); throw error }
}

export function* toolResponse(name, args, id = 'call-1') {
  const block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export function* routerResponse(options) {
  const user = options.messages.filter(message => message.role === 'user').at(-1)
  const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const completed = options.messages.slice(options.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
  const tool = options.tools?.[completed]
  if (!tool) { yield* textResponse('Recorded.'); return }
  const notification = tool.description.match(/Handle notification (\d+) only\./u)?.[1]
  const item = notification ? text.split(`Notification ${notification}:\n`)[1]?.split(/\nNotification \d+:\n/u)[0] : text
  if (tool.name.startsWith('deliver_result')) {
    const report = JSON.parse(item.slice('Ready report:'.length))
    yield* toolResponse(tool.name, { reportId: report.id }, `router-${completed}`)
  } else if (tool.name === 'establish_work_plan') {
    const brief = JSON.parse(item.slice(item.indexOf('{')).trim())
    const items = brief.requestedItems ?? [{ goal: brief.goal, constraints: brief.constraints, acceptanceCriteria: brief.acceptanceCriteria }]
    yield* toolResponse(tool.name, { items }, `router-${completed}`)
  } else yield* toolResponse(tool.name, {}, `router-${completed}`)
}

export async function* demonstrationResponse(options) {
  const user = options.messages.filter(message => message.role === 'user').at(-1)
  const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const followup = options.messages.slice(options.messages.lastIndexOf(user) + 1).some(message => message.role === 'tool')
  if (followup && options.model === 'worker') { yield* textResponse('Recorded.'); return }
  await new Promise((resolve, reject) => {
    const finish = () => { options.signal?.removeEventListener('abort', cancel); resolve() }
    const timer = setTimeout(finish, 650)
    const cancel = () => { clearTimeout(timer); reject(new Error('Mock request cancelled.')) }
    if (options.signal?.aborted) cancel()
    else options.signal?.addEventListener('abort', cancel, { once: true })
  })
  if (options.model === 'worker') {
    const match = text.match(/\b(\d{1,6})\s*\+\s*(\d{1,6})\b/u)
    if (!match) { yield* textResponse('This mock only completes addition requests.'); return }
    const answer = Number(match[1]) + Number(match[2])
    yield* toolResponse('report_ready', { result: `The answer is ${answer}.`, evidence: `Read the original request and checked ${match[1]} + ${match[2]} = ${answer}.` })
  } else yield* routerResponse(options)
}
