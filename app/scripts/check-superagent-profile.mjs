// Boot the app's ds-superagent profile without the Electron shell: the real
// profile bundles, the production Engine host and the existing ds-bot chat UI.
// Uses throwaway data and a mock model route; stops the Host before it exits.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { INSTALL_ANCHOR, SUPERAGENT_PROFILE, loadAppProfile } from '../src/profile.mjs'
import { reconcileSuperagentProfile } from '../src/superagent-patch.mjs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { routerResponse, textResponse, toolResponse } from '../../superagent/dev/native-mock.mjs'

const log = console.log
console.log = (...values) => log(...values.map(value => typeof value === 'string' ? value.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]') : value))

const home = mkdtempSync(join(tmpdir(), 'ds-superagent-profile-check-'))
process.env.DSH_HOME = home
process.env.DS_BOT_WORKSPACE = join(home, 'workspace')
mkdirSync(join(home, 'profiles'), { recursive: true })
const routePatch = join(home, 'profiles', 'superagent-mock-route.patch.yml')
writeFileSync(routePatch, [
  '- id: superagent-profile',
  '  config:',
  '    main: { provider: mock, model: main }',
  '    router: { provider: mock, model: router }',
  '    worker: { provider: mock, model: worker }',
  '',
].join('\n'))

let application
try {
  const profile = loadAppProfile(SUPERAGENT_PROFILE)
  const patchFiles = [reconcileSuperagentProfile(profile, true)[0], routePatch]
  application = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: SUPERAGENT_PROFILE,
    resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
    patchFiles,
    args: ['--no-open', '--port', '0'],
  })
  const { ctx } = application
  const services = ['superagentProduct', 'webServer', 'connection', 'sessionPersistence']
  const missing = services.filter(name => ctx.get(name) === undefined)
  if (missing.length) throw new Error(`The ds-superagent profile did not start: ${missing.join(', ')}`)
  const modelCalls = []
  class MockRoleAdapter extends LlmAdapter {
    async *stream(request) {
      modelCalls.push({ model: request.model,
        text: request.messages.filter(message => message.role === 'user').at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join(''),
        tools: request.tools?.map(tool => tool.name) })
      if (request.model === 'main') {
        const user = request.messages.filter(message => message.role === 'user').at(-1)
        const text = user?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
        if (text.startsWith('[Work update]')) {
          const notification = JSON.parse(text.split('\n').at(-1))
          yield* textResponse(notification.outcome?.summary ?? notification.update.summary)
          return
        }
        const toolCalls = request.messages.slice(request.messages.lastIndexOf(user) + 1).filter(message => message.role === 'tool').length
        if (text === 'Create and verify two local notes independently.' && toolCalls === 0) {
          yield* toolResponse('delegate_work', { items: [
            { goal: 'Create profile-alpha.txt with the exact accepted text.', constraints: 'Only write inside the configured local workspace.',
              acceptanceCriteria: 'Read profile-alpha.txt and confirm its exact contents.' },
            { goal: 'Create profile-beta.txt with the exact accepted text.', constraints: 'Only write inside the configured local workspace.',
              acceptanceCriteria: 'Read profile-beta.txt and confirm its exact contents.' },
          ] })
        } else yield* textResponse('The independent Main answered through the public DSH loop.')
        return
      }
      if (request.model === 'router') {
        yield* routerResponse(request)
        return
      }
      if (request.model !== 'worker') throw new Error(`Unexpected role route ${request.model}.`)
      const userIndex = request.messages.findLastIndex(message => message.role === 'user')
      const completed = request.messages.slice(userIndex + 1).filter(message => message.role === 'tool').length
      const userText = request.messages.filter(message => message.role === 'user')
        .flatMap(message => message.content?.filter(block => block.type === 'text').map(block => block.text) ?? [])
        .findLast(text => text.includes('Goal:\n') && text.includes('profile-')) ?? ''
      if (!userText) {
        yield* textResponse('No verified result was recorded.')
        return
      }
      const file = userText.includes('profile-alpha') ? 'profile-alpha.txt' : 'profile-beta.txt'
      const plan = [
        ['write_file', { path: file, text: `${file} written and verified\n` }],
        ['read_file', { path: file }],
        ['report_ready', { result: `Created ${file}.`, evidence: `Read back the exact accepted text from ${file}.`, artifacts: file }],
      ][completed]
      if (plan) yield* toolResponse(plan[0], plan[1], `profile-worker-${completed}`)
      else yield* textResponse('No result was recorded.')
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockRoleAdapter())
  const binding = await ctx.superagentProduct.dispatch('open')
  assert.equal(ctx.get('sessionController'), undefined, 'the native controller is isolated from the product Gateway')
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: {
    request: { requestId: 'forbidden-native', sessionId: binding.mainSessionId, mode: 'queue', content: [{ type: 'text', text: 'This must be refused.' }] },
  }, peer: ctx.connection.browserPeer }), { code: 'gateway/service-unavailable' })
  await assert.rejects(ctx.typertGateway.stream({ namespace: 'session', method: 'control', args: {}, peer: ctx.connection.browserPeer }), { code: 'gateway/service-unavailable' })
  await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'profile-smoke', text: 'Hello Main.' })
  let history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId })
  if (history.messages.length !== 2 || history.messages[1].role !== 'main') throw new Error('Main did not produce a durable reply.')
  await ctx.superagentProduct.dispatch('send', { instanceId: binding.instanceId, commandId: 'profile-delegation', text: 'Create and verify two local notes independently.' })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    history = await ctx.superagentProduct.dispatch('history', { instanceId: binding.instanceId })
    if (history.works?.length === 2 && history.works.every(work => work.status === 'success')) break
    await sleep(50)
  }
  assert.equal(history.works?.length, 2, JSON.stringify({ messages: history.messages, works: history.works, modelCalls }, null, 2))
  assert.equal(history.works.every(work => work.receipt.status === 'accepted' && work.status === 'success'), true)
  assert.equal(new Set(history.works.map(work => work.brief.workItemId)).size, 2)
  assert.equal(new Set(history.works.map(work => work.brief.sourceEventId)).size, 1)
  assert.deepEqual(history.works.map(work => work.outcome.artifacts[0].path).sort(), ['profile-alpha.txt', 'profile-beta.txt'], JSON.stringify({ works: history.works, modelCalls }, null, 2))
  assert.equal(await readFile(join(process.env.DS_BOT_WORKSPACE, 'profile-alpha.txt'), 'utf8'), 'profile-alpha.txt written and verified\n')
  assert.equal(await readFile(join(process.env.DS_BOT_WORKSPACE, 'profile-beta.txt'), 'utf8'), 'profile-beta.txt written and verified\n')
  if (ctx.get('botExecutionAdapter') !== undefined) throw new Error('The old execution adapter must not mount in the product profile.')
  console.log(JSON.stringify({ profile: SUPERAGENT_PROFILE, home, services, messages: history.messages.filter(message => !message.id.startsWith('reply:main-update:')).length,
    localWorkStatus: history.works.every(work => work.status === 'success') ? 'success' : 'failed', localWorkItems: history.works.length,
    nativeSessionAccessDenied: true }))
} finally {
  try { await application?.shutdown?.shutdown?.(0) } catch {}
  rmSync(home, { recursive: true, force: true })
  console.log = log
}
