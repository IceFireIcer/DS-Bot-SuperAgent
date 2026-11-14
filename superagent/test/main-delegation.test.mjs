import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check, label) {
  const deadline = Date.now() + 15_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Main delegation did not reach ${label}.`)
    await sleep(20)
  }
}

test('Main delegates one durable local brief and reports only the Worker result and evidence', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-delegation-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const roles = []
  const updates = []
  let failFirstMainUpdate = true
  function* respond(options) {
    roles.push(options.model)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (lastUserText(options).startsWith('[Work update]')) {
        const notification = JSON.parse(lastUserText(options).split('\n').at(-1))
        updates.push(notification)
        if (notification.outcome?.status === 'success' && failFirstMainUpdate) {
          failFirstMainUpdate = false
          throw new Error('Transient Main route failure.')
        }
        yield* textResponse(notification.outcome?.summary ?? notification.update.summary)
        return
      }
      if (calls === 0) yield* toolResponse('delegate_work', {
        goal: lastUserText(options) === 'Try one incomplete local work item.'
          ? 'Inspect the sample without claiming a completed change.'
          : 'Create checked-note.txt containing the exact text delegated by Main.',
        constraints: 'Write only below the configured workspace root.',
        acceptanceCriteria: lastUserText(options) === 'Try one incomplete local work item.'
          ? 'Report only a verified result; otherwise leave it incomplete.'
          : 'Read the written file and confirm its exact contents before reporting success.',
      })
      else yield* textResponse('The Router accepted this work. I will report the verified result when it is ready.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    if (lastUserText(options).includes('Inspect the sample')) {
      yield* textResponse('I inspected the request but did not verify or complete it.')
      return
    }
    const next = [
      ['write_file', { path: 'checked-note.txt', text: 'delegated and verified\n' }],
      ['read_file', { path: 'checked-note.txt' }],
      ['report_ready', { result: 'Created checked-note.txt.', evidence: 'The Worker read back the exact delegated contents.', artifacts: 'checked-note.txt' }],
    ][calls]
    if (next) yield* toolResponse(next[0], next[1], `worker-${calls}`)
    else yield* textResponse('No result was recorded.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(storage, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop()
    await engine.shutdown()
    await sessions.close()
    await native.fiber.dispose()
    await environment.close()
    await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  const binding = await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  const command = { instanceId: 'personal', commandId: 'delegate-note', text: 'Please create and verify a note containing delegated and verified.' }
  await engine.sendMainMessage(command)
  try {
    await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works?.some(work => work.status === 'success'), 'the evidence-backed result')
  } catch (error) {
    console.error(JSON.stringify({ roles, history: await engine.getMainConversation({ instanceId: 'personal' }), tickets: await engine.listTickets(), effects: await engine.effects.list() }, null, 2))
    throw error
  }

  let history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(history.works.length, 1)
  const [work] = history.works
  assert.equal(work.receipt.status, 'accepted')
  assert.equal(work.outcome.status, 'success')
  assert.match(work.outcome.summary, /checked-note\.txt/u)
  assert.match(work.outcome.evidence, /read back/u)
  assert.deepEqual(work.outcome.artifacts.map(artifact => artifact.path), ['checked-note.txt'])
  assert.equal(await readFile(join(root, 'checked-note.txt'), 'utf8'), 'delegated and verified\n')
  assert.deepEqual(new Set(roles), new Set(['main', 'router', 'worker']))
  assert.equal((await engine.listTickets()).items.length, 1)
  assert.deepEqual(history.messages.filter(message => message.role === 'user').map(message => message.id).length, 1)
  await until(async () => updates.some(update => update.outcome?.status === 'success'), 'Main receiving the bounded verified result')
  await until(async () => updates.filter(update => update.outcome?.status === 'success').length === 2, 'the stable Main notification retry')
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).messages.some(message => message.text === 'Created checked-note.txt.'), 'Main committing the verified result reply')
  history = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(updates.filter(update => update.outcome?.status === 'success').length, 2)
  assert.equal(history.messages.filter(message => message.text === 'Created checked-note.txt.').length, 1)
  assert.equal(updates.find(update => update.outcome?.status === 'success').receipt.ticketId, work.receipt.ticketId)
  assert.equal(history.works[0].update.version, 1)
  assert.equal(history.works[0].update.needsDecision, false)
  const routerHistory = await engine.getSessionHistory(binding.routerSessionId, { limit: 100 })
  const routerText = JSON.stringify(routerHistory)
  assert.match(routerText, /versioned Main WorkBrief/u)
  assert.match(routerText, /Ready report:|bounded, verified work state/u)
  assert.equal(JSON.stringify(updates).includes('tool/call'), false)

  await engine.sendMainMessage(command)
  await assert.rejects(engine.sendMainMessage({ ...command, text: 'Edit a different file instead.' }), { code: 'IDENTITY_CONFLICT' })
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'incomplete-work', text: 'Try one incomplete local work item.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(item => item.brief.goal.startsWith('Inspect the sample') && item.outcome?.status === 'failed'), 'an explicit unverified result')
  const final = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(final.works.length, 2)
  const incomplete = final.works.find(item => item.brief.goal.startsWith('Inspect the sample'))
  assert.equal(incomplete.outcome.status, 'failed')
  assert.equal(incomplete.outcome.summary, 'The Worker ended without a verified result.')
  await until(async () => updates.some(update => update.outcome?.status === 'failed'), 'Main receiving the failed work state')
  assert.equal(final.messages.at(-1).role, 'main')
  assert.equal(final.messages.at(-1).status, 'completed')
  assert.equal((await engine.listTickets()).items.length, 2)
})
