import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { CoreError, Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { SqliteStorage } from '../dist/storage.js'
import { completedToolCount, lastUserText } from './input-support.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'

async function until(check, label) {
  const deadline = Date.now() + 20_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Parallel Main delegation did not reach ${label}.`)
    await sleep(20)
  }
}

function goalFromWorkerPrompt(text) {
  return text.match(/(?:^|\n)Goal:\n(.+?)(?:\n\n|$)/u)?.[1] ?? ''
}

test('one Main request creates two independent work items and lets the fast one finish without the slow one', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-parallel-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const updates = []
  const roles = []

  async function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    roles.push(options.model)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        updates.push(JSON.parse(text.split('\n').at(-1)))
        yield* textResponse('Both independent work items will report separately.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          items: [
            { goal: 'Prepare the alpha note.', constraints: 'Write only alpha.txt.', acceptanceCriteria: 'Read alpha.txt back and report its exact contents.' },
            { goal: 'Independently investigate the beta note.', constraints: 'Write only beta.txt.', acceptanceCriteria: 'Read beta.txt back and report its exact contents.' },
          ],
          constraints: 'Use only the authorized workspace.',
          acceptanceCriteria: 'Both items must carry their own verified evidence.',
        })
        return
      }
      yield* textResponse('The Router will report both items separately.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    const goal = goalFromWorkerPrompt(text)
    const file = goal.includes('alpha') ? 'alpha.txt' : 'beta.txt'
    const value = goal.includes('alpha') ? 'alpha complete\n' : 'beta complete\n'
    if (calls === 0) yield* toolResponse('write_file', { path: file, text: value })
    else if (calls === 1) yield* toolResponse('read_file', { path: file })
    else if (calls === 2) {
      if (file === 'beta.txt') await sleep(900)
      yield* toolResponse('report_ready', {
        result: `${file} is complete.`, evidence: `Read ${file} back after writing it.`, artifacts: file,
      })
    } else yield* textResponse('No result was recorded.')
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
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'parallel-note', text: 'Prepare A and independently investigate B.' })
  try {
    await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(work => work.outcome?.status === 'success'), 'the first verified item')
  } catch (error) {
    console.error(JSON.stringify({ roles, history: await engine.getMainConversation({ instanceId: 'personal' }),
      tickets: await engine.listTickets(), effects: await engine.effects.list() }, null, 2))
    throw error
  }

  const early = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(early.works.length, 2)
  const fast = early.works.find(work => work.brief.goal.includes('alpha'))
  const slow = early.works.find(work => work.brief.goal.includes('beta'))
  assert.equal(fast?.outcome?.status, 'success')
  assert.notEqual(slow?.outcome?.status, 'success')
  assert.equal(early.messages.filter(message => message.role === 'user').length, 1)

  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.every(work => work.outcome?.status === 'success'), 'both verified items')
  const final = await engine.getMainConversation({ instanceId: 'personal' })
  assert.equal(final.works.length, 2)
  assert.deepEqual(final.works.map(work => work.brief.goal), ['Prepare the alpha note.', 'Independently investigate the beta note.'])
  assert.equal(new Set(final.works.map(work => work.brief.sourceEventId)).size, 1)
  assert.equal(new Set(final.works.map(work => work.brief.workItemId)).size, 2)
  assert.equal(new Set(final.works.map(work => work.receipt.ticketId)).size, 2)
  assert.equal(new Set(final.works.map(work => work.brief.id)).size, 1)
  assert.equal(await readFile(join(root, 'alpha.txt'), 'utf8'), 'alpha complete\n')
  assert.equal(await readFile(join(root, 'beta.txt'), 'utf8'), 'beta complete\n')

  const plan = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: final.works[0].brief.id })
  assert.equal(plan.items.length, 2)
  assert.equal(plan.items.every(item => item.ticketId && item.receipt.status === 'accepted'), true)
  const tickets = (await engine.listTickets()).items
  assert.equal(tickets.length, 2)
  assert.equal(new Set(tickets.map(work => work.mandate.id)).size, 2)
  assert.equal(new Set(tickets.map(work => work.decision.id)).size, 2)
  assert.equal(new Set(tickets.map(work => work.trigger.id)).size, 2)
  assert.equal(new Set(tickets.map(work => work.trigger.eventId)).size, 1)
  assert.equal(tickets.every(work => work.trigger.text.includes('Prepare A and independently investigate B.')), true)
  const assignments = await Promise.all(tickets.map(work => engine.conversation(work.ticket.id))).then(items => items.map(item => item.assignments[0]))
  assert.equal(new Set(assignments.map(assignment => assignment.sessionId)).size, 2)
  assert.deepEqual(new Set(tickets.map(work => work.mandate.scope)), new Set([
    'Prepare the alpha note.', 'Independently investigate the beta note.',
  ]))
  await until(async () => updates.filter(update => update.outcome?.status === 'success').length >= 2, 'two bounded Main result updates')
})

test('a partial work-plan commit survives restart and fills only the missing item', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-partial-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  let changePlanOnRestart = false

  async function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* textResponse('The independent work update was recorded.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          items: [
            { goal: 'Write the recovery alpha note.', constraints: 'Write only recovery-alpha.txt.', acceptanceCriteria: 'Read recovery-alpha.txt back.' },
            { goal: 'Write the recovery beta note.', constraints: 'Write only recovery-beta.txt.', acceptanceCriteria: 'Read recovery-beta.txt back.' },
          ],
        })
        return
      }
      yield* textResponse('The Router accepted both items.')
      return
    }
    if (options.model === 'router') {
      if (changePlanOnRestart && calls === 0) {
        yield* toolResponse('establish_work_plan', {
          items: [
            { goal: 'Write the recovery alpha note.', constraints: 'Write only recovery-alpha.txt.', acceptanceCriteria: 'Read recovery-alpha.txt back.' },
            { goal: 'Replace the beta item with unrelated gamma work.', constraints: 'Write gamma.txt.', acceptanceCriteria: 'Read gamma.txt back.' },
          ],
        }, 'changed-plan')
        return
      }
      if (changePlanOnRestart) {
        yield* textResponse('Recorded the existing plan conflict.')
        return
      }
      yield* routerResponse(options)
      return
    }
    const goal = goalFromWorkerPrompt(text)
    const file = goal.includes('alpha') ? 'recovery-alpha.txt' : 'recovery-beta.txt'
    if (calls === 0) yield* toolResponse('write_file', { path: file, text: `${file}\n` })
    else if (calls === 1) yield* toolResponse('read_file', { path: file })
    else if (calls === 2) yield* toolResponse('report_ready', {
      result: `${file} is complete.`, evidence: `Read ${file} back.`, artifacts: file,
    })
    else yield* textResponse('No result was recorded.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  let ticketInserts = 0
  let failSecondTicket = true
  const interrupted = {
    transaction(instanceId, operation) {
      return storage.transaction(instanceId, tx => operation({
        ...tx,
        insert: async (kind, key, value) => {
          if (kind === 'ticket' && failSecondTicket && ++ticketInserts === 2) {
            failSecondTicket = false
            throw new CoreError('STORAGE_UNAVAILABLE', 'Simulated outage after the first item committed.')
          }
          return tx.insert(kind, key, value)
        },
      }))
    },
    reconnect: () => storage.reconnect(), close: () => storage.close(),
  }
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const source = { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] }
  let engine = new Engine(interrupted, 'personal', source, { scanIntervalMs: 10, retryDelayMs: 1000 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  const command = { instanceId: 'personal', commandId: 'partial-parallel', text: 'Write the recovery alpha and beta notes independently.' }
  await engine.sendMainMessage(command)
  await until(async () => {
    const history = await engine.getMainConversation({ instanceId: 'personal' })
    if (history.works.length !== 2) return false
    const plan = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: history.works[0].brief.id })
    return plan.items.filter(item => item.receipt.status === 'accepted').length === 1
  }, 'one durable item before the second commit')
  const partialHistory = await engine.getMainConversation({ instanceId: 'personal' })
  const briefId = partialHistory.works[0].brief.id
  const partial = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: briefId })
  const accepted = partial.items.find(item => item.receipt.status === 'accepted')
  const missing = partial.items.find(item => item.receipt.status === 'routing')
  assert.equal(accepted?.ticketId !== undefined, true)
  assert.equal(missing?.ticketId, undefined)
  const firstItemId = accepted.id
  const firstTicketId = accepted.ticketId

  await engine.effects.stop()
  await engine.shutdown()
  changePlanOnRestart = true
  engine = new Engine(storage, 'personal', source, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()

  await until(async () => {
    const plan = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: briefId })
    return plan.items.length === 2 && plan.items.every(item => item.receipt.status === 'accepted')
      && (await engine.listTickets()).items.length === 2
  }, 'the missing Ticket after restart')
  const recovered = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: briefId })
  assert.equal(recovered.status, 'accepted')
  assert.match(recovered.conflict.message, /different target decision|new Main request/iu)
  assert.equal(recovered.conflict.attemptedItems.some(item => item.goal.includes('gamma')), true)
  assert.deepEqual(recovered.items.map(item => item.goal), partial.items.map(item => item.goal))
  assert.equal(recovered.items.find(item => item.id === firstItemId)?.ticketId, firstTicketId)
  assert.equal(recovered.items.find(item => item.id === missing.id)?.ticketId !== undefined, true)
  assert.equal((await engine.getMainConversation({ instanceId: 'personal' })).messages.filter(message => message.role === 'user').length, 1)

  const ticketIds = (await engine.listTickets()).items.map(work => work.ticket.id).sort()
  await engine.sendMainMessage(command)
  await assert.rejects(engine.sendMainMessage({ ...command, text: 'Turn the same identity into a different plan.' }), { code: 'IDENTITY_CONFLICT' })
  assert.deepEqual((await engine.listTickets()).items.map(work => work.ticket.id).sort(), ticketIds)
})

test('a routing WorkBrief from R5-02 gains one durable source identity before its split', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-legacy-brief-'))
  const root = join(directory, 'workspace')
  await mkdir(root)

  async function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        yield* textResponse('The migrated work is complete.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Create migrated legacy work.', constraints: 'Write only legacy.txt.',
          acceptanceCriteria: 'Read legacy.txt back before success.',
        })
        return
      }
      yield* textResponse('The work plan is routing.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (calls === 0) yield* toolResponse('write_file', { path: 'legacy.txt', text: 'legacy migrated\n' })
    else if (calls === 1) yield* toolResponse('read_file', { path: 'legacy.txt' })
    else if (calls === 2) yield* toolResponse('report_ready', { result: 'Migrated legacy work.', evidence: 'Read legacy.txt back.', artifacts: 'legacy.txt' })
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
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'legacy-brief', text: 'Create the migrated legacy work.' })
  const routing = await engine.getMainConversation({ instanceId: 'personal' })
  const briefId = routing.works[0].brief.id
  await storage.transaction('personal', async tx => {
    const brief = await tx.get('work-brief', briefId)
    delete brief.sourceEventId
    delete brief.requestedItems
    await tx.replace('work-brief', briefId, brief)
  })
  engine.effects.start()

  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(work => work.outcome?.status === 'success'), 'legacy routing migration')
  const plan = await engine.getMainWorkPlan({ instanceId: 'personal', workBriefId: briefId })
  assert.equal(plan.sourceEventId, `main-work-source:${briefId}`)
  assert.equal(plan.items.length, 1)
  assert.equal(plan.items[0].receipt.status, 'accepted')
  assert.equal(await readFile(join(root, 'legacy.txt'), 'utf8'), 'legacy migrated\n')
})

test('a Worker result hydrates a missing accepted receipt before notifying Main', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'r5-main-receipt-race-'))
  const root = join(directory, 'workspace')
  await mkdir(root)
  const updates = []

  async function* respond(options) {
    const text = lastUserText(options)
    const calls = completedToolCount(options)
    if (options.model === 'main') {
      if (text.startsWith('[Work update]')) {
        updates.push(JSON.parse(text.split('\n').at(-1)))
        yield* textResponse('The verified receipt was recorded.')
        return
      }
      if (calls === 0) {
        yield* toolResponse('delegate_work', {
          goal: 'Create receipt-race.txt.', constraints: 'Write only receipt-race.txt.',
          acceptanceCriteria: 'Read receipt-race.txt back before success.',
        })
        return
      }
      yield* textResponse('The work plan is routing.')
      return
    }
    if (options.model === 'router') {
      yield* routerResponse(options)
      return
    }
    if (calls === 0) yield* toolResponse('write_file', { path: 'receipt-race.txt', text: 'receipt race complete\n' })
    else if (calls === 1) yield* toolResponse('read_file', { path: 'receipt-race.txt' })
    else if (calls === 2) yield* toolResponse('report_ready', {
      result: 'Completed despite a delayed receipt.', evidence: 'Read receipt-race.txt back.', artifacts: 'receipt-race.txt',
    })
    else yield* textResponse('No result was recorded.')
  }

  const environment = await LocalEnvironment.open({ id: 'product-workspace', instanceId: 'personal', root,
    allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
  const native = await nativeContext(join(directory, 'sessions'), respond)
  const storage = await SqliteStorage.open(join(directory, 'state.sqlite'))
  let failAcceptedReceipt = true
  const interrupted = {
    transaction(instanceId, operation) {
      return storage.transaction(instanceId, tx => operation({
        ...tx,
        replace: async (kind, key, value) => {
          if (failAcceptedReceipt && kind === 'work-receipt' && value?.status === 'accepted' && value?.workItemId) {
            failAcceptedReceipt = false
            throw new CoreError('STORAGE_UNAVAILABLE', 'Simulated accepted-receipt outage.')
          }
          return tx.replace(kind, key, value)
        },
      }))
    },
    reconnect: () => storage.reconnect(), close: () => storage.close(),
  }
  const sessions = new NativeSessions(native, {
    main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' },
  })
  const engine = new Engine(interrupted, 'personal', { sourceInstanceId: 'product-desktop', actorId: 'alice', allowedActorIds: ['alice'] },
    { scanIntervalMs: 10, retryDelayMs: 500 }, sessions, [environment])
  t.after(async () => {
    await engine.effects.stop(); await engine.shutdown(); await sessions.close()
    await native.fiber.dispose(); await environment.close(); await storage.close()
    await rm(directory, { recursive: true, force: true })
  })

  await engine.openMain({ instanceId: 'personal' })
  engine.effects.start()
  await engine.sendMainMessage({ instanceId: 'personal', commandId: 'receipt-race', text: 'Create the receipt race file.' })
  await until(async () => (await engine.getMainConversation({ instanceId: 'personal' })).works.some(work => work.outcome?.status === 'success'), 'the Worker result')
  await until(async () => updates.some(update => update.outcome?.status === 'success'), 'the verified Main update')
  const success = updates.find(update => update.outcome?.status === 'success')
  assert.equal(success.receipt.status, 'accepted')
  assert.equal(success.receipt.ticketId, success.outcome.ticketId)
  assert.equal(await readFile(join(root, 'receipt-race.txt'), 'utf8'), 'receipt race complete\n')
})
