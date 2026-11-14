import assert from 'node:assert/strict'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CoreError, Effects, Engine, LocalEnvironment, NativeSessions } from '../dist/index.js'
import { PostgresStorage } from '../dist/postgres-storage.js'
import { commandTransaction } from '../dist/commands.js'
import { commitProxy } from '../dev/postgres-commit-proxy.mjs'
import { nativeContext, routerResponse, textResponse, toolResponse } from '../dev/native-mock.mjs'
import { completedToolCount } from './input-support.mjs'
import { startPostgres } from './fixtures/postgres-harness.mjs'

const postgres = await startPostgres()
const { directory, port, password, configuration, client, database, newStorage } = postgres
const proxies = []

test('PostgreSQL preserves Main identity, deduplicates messages and isolates another Instance', { timeout: 30000 }, async t => {
  const { storage } = await newStorage()
  const native = await nativeContext(join(directory, 'main-sessions'), function* () { yield* textResponse('A durable Main reply.') })
  const sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' }, router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const source = { sourceInstanceId: 'product', actorId: 'alice', allowedActorIds: ['alice'] }
  let engine = new Engine(storage, 'main-personal', source, {}, sessions)
  const team = new Engine(storage, 'main-team', source, {}, sessions)
  t.after(async () => { await engine.shutdown(); await team.shutdown(); await sessions.close(); await native.fiber.dispose() })
  const binding = await engine.openMain({ instanceId: 'main-personal' })
  const command = { instanceId: 'main-personal', commandId: 'one', text: 'Hello Main.' }
  await engine.sendMainMessage(command)
  await engine.shutdown()
  engine = new Engine(storage, 'main-personal', source, {}, sessions)
  assert.deepEqual(await engine.openMain({ instanceId: 'main-personal' }), binding)
  await engine.sendMainMessage(command)
  assert.deepEqual((await engine.getMainConversation({ instanceId: 'main-personal' })).messages.map(message => message.text), ['Hello Main.', 'A durable Main reply.'])
  await assert.rejects(engine.sendMainMessage({ ...command, text: 'Different text.' }), { code: 'IDENTITY_CONFLICT' })
  await assert.rejects(engine.getMainConversation({ instanceId: 'main-team' }), { code: 'SOURCE_NOT_AUTHORIZED' })
  assert.deepEqual((await team.getMainConversation({ instanceId: 'main-team' })).messages, [])
  assert.deepEqual((await engine.listTickets()).items, [])
})

test('PostgreSQL persists a split Main WorkPlan, every Ticket receipt and verified local Outcome', { timeout: 60000 }, async t => {
  const { storage } = await newStorage()
  const root = join(directory, 'main-workspace')
  await mkdir(root, { recursive: true })
  const sessionRoot = join(directory, 'main-work-sessions')
  const source = { sourceInstanceId: 'product-work', actorId: 'alice', allowedActorIds: ['alice'] }
  let environment, native, sessions, engine
  const roles = []
  function* respond(options) {
    roles.push(options.model)
    if (options.model === 'main') {
      const user = options.messages.filter(message => message.role === 'user').at(-1)
      const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text.startsWith('[Work update]')) { yield* textResponse('The Router work update is recorded.'); return }
      if (text === 'Create two checked files independently.' && completedToolCount(options) === 0) yield* toolResponse('delegate_work', {
        items: [
          { goal: 'Create postgres-alpha.txt.', constraints: 'Write only inside the configured workspace.', acceptanceCriteria: 'Read back postgres-alpha.txt before success.' },
          { goal: 'Create postgres-beta.txt.', constraints: 'Write only inside the configured workspace.', acceptanceCriteria: 'Read back postgres-beta.txt before success.' },
        ],
      })
      else yield* textResponse('The local work result is available.')
      return
    }
    if (options.model === 'router') { yield* routerResponse(options); return }
    const user = options.messages.filter(message => message.role === 'user').at(-1)
    const text = user.content.filter(block => block.type === 'text').map(block => block.text).join('')
    const file = text.includes('postgres-alpha') ? 'postgres-alpha.txt' : 'postgres-beta.txt'
    const plan = [
      ['write_file', { path: file, text: `${file} durable result\n` }],
      ['read_file', { path: file }],
      ['report_ready', { result: `Created ${file}.`, evidence: `The Worker read ${file}.`, artifacts: file }],
    ][completedToolCount(options)]
    if (plan) yield* toolResponse(plan[0], plan[1], `postgres-worker-${completedToolCount(options)}`)
    else yield* textResponse('No verified result was recorded.')
  }
  async function open() {
    environment = await LocalEnvironment.open({ id: 'postgres-workspace', instanceId: 'postgres-work', root,
      allowedActorIds: ['alice'], permissions: ['read', 'write'], commands: {} })
    native = await nativeContext(sessionRoot, respond)
    sessions = new NativeSessions(native, { main: { provider: 'mock', model: 'main' },
      router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
    engine = new Engine(storage, 'postgres-work', source, { scanIntervalMs: 10, retryDelayMs: 10 }, sessions, [environment])
    await engine.openMain({ instanceId: 'postgres-work' })
    engine.effects.start()
  }
  async function close() {
    await engine?.effects.stop()
    await engine?.shutdown()
    await sessions?.close()
    await native?.fiber.dispose()
    await environment?.close()
    engine = undefined; sessions = undefined; native = undefined; environment = undefined
  }
  t.after(close)

  await open()
  const command = { instanceId: 'postgres-work', commandId: 'postgres-delegate', text: 'Create two checked files independently.' }
  await engine.sendMainMessage(command)
  let history
  for (let attempt = 0; attempt < 500; attempt++) {
    history = await engine.getMainConversation({ instanceId: 'postgres-work' })
    if (history.works.length === 2 && history.works.every(work => work.status === 'success')) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(history.works.length, 2)
  assert.equal(history.works.every(work => work.receipt.status === 'accepted'), true)
  assert.deepEqual(history.works.map(work => work.outcome.summary).sort(), ['Created postgres-alpha.txt.', 'Created postgres-beta.txt.'])
  assert.equal(roles.includes('worker'), true)
  assert.equal((await engine.listTickets()).items.length, 2)
  const plan = await engine.getMainWorkPlan({ instanceId: 'postgres-work', workBriefId: history.works[0].brief.id })
  assert.equal(plan.items.length, 2)
  assert.equal(plan.status, 'accepted')
  const identities = plan.items.map(item => [item.id, item.ticketId])

  await close()
  await open()
  await engine.sendMainMessage(command)
  const restored = await engine.getMainConversation({ instanceId: 'postgres-work' })
  assert.equal(restored.works.length, 2)
  assert.deepEqual(restored.works.map(work => work.outcome.reportId).sort(), history.works.map(work => work.outcome.reportId).sort())
  assert.deepEqual((await engine.getMainWorkPlan({ instanceId: 'postgres-work', workBriefId: plan.workBriefId })).items.map(item => [item.id, item.ticketId]), identities)
  assert.equal((await engine.listTickets()).items.length, 2)
})

after(async () => {
  await Promise.allSettled(proxies.map(proxy => proxy.close()))
  await postgres.close()
})

function gate() {
  let resolve
  const promise = new Promise(open => { resolve = open })
  return { promise, resolve }
}

test('the isolated PostgreSQL server keeps durable commit settings', { timeout: 30000 }, async () => {
  const admin = await client()
  const settings = (await admin.query(`SELECT current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('listen_addresses') AS listen`)).rows[0]
  assert.equal(settings.fsync, 'on')
  assert.equal(settings.synchronous_commit, 'on')
  assert.equal(settings.listen, '127.0.0.1')
})

test('PostgreSQL implements the record contract, including rollback and ordering', { timeout: 30000 }, async () => {
  const { storage } = await newStorage()
  await storage.transaction('alpha', async transaction => {
    await transaction.insert('command', 'one', { value: 1 })
    await transaction.insert('command', 'two', { value: 2 })
    await transaction.insert('command', 'three', { value: 3 })
  })
  assert.deepEqual(await storage.transaction('alpha', transaction => transaction.get('command', 'one')), { value: 1 })
  assert.equal(await storage.transaction('alpha', transaction => transaction.replace('command', 'one', { value: 10 })), true)
  assert.equal(await storage.transaction('alpha', transaction => transaction.replace('command', 'missing', { value: 0 })), false)
  assert.deepEqual(await storage.transaction('alpha', transaction => transaction.list('command', 3)), [{ value: 10 }, { value: 2 }, { value: 3 }])
  const scan = await storage.transaction('alpha', transaction => transaction.scan('command', { limit: 2 }))
  assert.deepEqual(scan.items.map(item => item.id), ['one', 'three'])
  assert.equal(scan.cursor, 'three')
  assert.equal(await storage.transaction('alpha', transaction => transaction.remove('command', 'two')), true)
  assert.equal(await storage.transaction('alpha', transaction => transaction.get('command', 'two')), undefined)
  await assert.rejects(storage.transaction('alpha', async transaction => {
    await transaction.insert('command', 'rolled-back', { value: 0 })
    throw new Error('rollback please')
  }), /rollback please/u)
  assert.equal(await storage.transaction('alpha', transaction => transaction.get('command', 'rolled-back')), undefined)
})

test('the Instance coordinator serializes one Instance while another advances', { timeout: 30000 }, async () => {
  const { storage } = await newStorage({ lockTimeoutMs: 100 })
  const entered = gate(), release = gate()
  const first = storage.transaction('same', async transaction => {
    await transaction.insert('command', 'first', { accepted: true })
    entered.resolve()
    await release.promise
  })
  await entered.promise
  await assert.rejects(storage.transaction('same', transaction => transaction.insert('command', 'blocked', { accepted: true })),
    { code: 'LOCK_TIMEOUT' })
  await storage.transaction('other', transaction => transaction.insert('command', 'independent', { accepted: true }))
  assert.deepEqual(await storage.transaction('other', transaction => transaction.get('command', 'independent')), { accepted: true })
  release.resolve()
  await first
  assert.deepEqual(await storage.transaction('same', transaction => transaction.get('command', 'first')), { accepted: true })
  assert.equal(await storage.transaction('same', transaction => transaction.get('command', 'blocked')), undefined)
})

test('connection string options cannot disable the first coordinator insert lock budget', { timeout: 30000 }, async () => {
  const fixture = await database()
  const url = new URL(`postgresql://127.0.0.1:${port}/${fixture.name}`)
  url.username = 'postgres'
  url.password = password
  url.searchParams.set('options', '-c lock_timeout=0 -c statement_timeout=0 -c search_path=pg_catalog')
  const storage = await PostgresStorage.open({ connectionString: url.href, lockTimeoutMs: 100, statementTimeoutMs: 1000 })
  postgres.register(storage)
  await fixture.client.query('BEGIN; LOCK TABLE ds_superagent_instances IN ACCESS EXCLUSIVE MODE')
  try {
    await assert.rejects(storage.transaction('first', transaction => transaction.insert('command', 'blocked', {})), { code: 'LOCK_TIMEOUT' })
  } finally { await fixture.client.query('ROLLBACK') }
  assert.equal(await storage.transaction('first', transaction => transaction.get('command', 'blocked')), undefined)
})

test('transaction capabilities expire on both commit and rollback before a pooled connection is reused', async () => {
  const { storage } = await newStorage({ maxConnections: 1 })
  let retained
  await storage.transaction('capability', async transaction => { retained = transaction })
  await assert.rejects(retained.insert('command', 'late', {}), { code: 'TRANSACTION_CLOSED' })
  await assert.rejects(storage.transaction('capability', async transaction => {
    retained = transaction
    throw new Error('abort')
  }), /abort/u)
  await storage.transaction('other-capability', async transaction => {
    await assert.rejects(retained.get('command', 'late'), { code: 'TRANSACTION_CLOSED' })
    await transaction.insert('command', 'valid', {})
  })
})

test('concurrent same command IDs share one receipt and reject a different fingerprint', { timeout: 30000 }, async () => {
  const { storage } = await newStorage()
  const command = fingerprint => async transaction => {
    const prior = await transaction.get('command', 'duplicate')
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new CoreError('IDENTITY_CONFLICT', 'The command was reused for different input.')
      return prior.receipt
    }
    const receipt = { accepted: true }
    await transaction.insert('event', 'once', { accepted: true })
    await transaction.insert('command', 'duplicate', { fingerprint, receipt })
    return receipt
  }
  const [left, right] = await Promise.all([
    commandTransaction(storage, 'duplicate', command('fingerprint-1')),
    commandTransaction(storage, 'duplicate', command('fingerprint-1')),
  ])
  assert.deepEqual(left, { accepted: true })
  assert.deepEqual(right, { accepted: true })
  assert.deepEqual(await storage.transaction('duplicate', transaction => transaction.get('event', 'once')), { accepted: true })
  await assert.rejects(commandTransaction(storage, 'duplicate', command('fingerprint-2')), { code: 'IDENTITY_CONFLICT' })
})

test('COMMIT acknowledgement loss reconciles the original command on a fresh locked connection', { timeout: 30000 }, async () => {
  const proxy = await commitProxy(port, 'after-commit')
  proxies.push(proxy)
  const { storage: direct, database: databaseName } = await newStorage()
  await direct.close()
  const storage = await PostgresStorage.open({ ...configuration, database: databaseName, port: proxy.port })
  postgres.register(storage)
  proxy.arm()
  const command = async transaction => {
    const prior = await transaction.get('command', 'commit-unknown')
    if (prior) return prior.receipt
    const receipt = { committed: true }
    await transaction.insert('event', 'commit-once', { committed: true })
    await transaction.insert('command', 'commit-unknown', { receipt })
    return receipt
  }
  assert.deepEqual(await commandTransaction(storage, 'commit', command), { committed: true })
  assert.equal(proxy.evidence.commitCompleteSeen, true)
  assert.equal(proxy.evidence.suppressedCommit, true)
  assert.equal(proxy.evidence.readySuppressed, true)
  assert.deepEqual(await storage.transaction('commit', transaction => transaction.get('event', 'commit-once')), { committed: true })
  assert.equal(await storage.transaction('commit', async transaction => (await transaction.list('event', 2)).length), 1)
})

test('a real serialization failure retries the whole READ COMMITTED command with the same identity', { timeout: 30000 }, async () => {
  const { storage, database: databaseName } = await newStorage()
  const raw = await client(databaseName)
  await raw.query(`CREATE SEQUENCE serialization_attempt;
    CREATE FUNCTION reject_first_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id='counter' AND nextval('serialization_attempt')=1 THEN
        RAISE EXCEPTION 'serialization conflict' USING ERRCODE='40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_first_insert BEFORE INSERT ON ds_superagent_records
      FOR EACH ROW EXECUTE FUNCTION reject_first_insert()`)
  let attempts = 0
  const result = await commandTransaction(storage, 'serial', async transaction => {
    attempts++
    const next = { value: attempts }
    await transaction.insert('command', 'counter', next)
    return next
  })
  assert.equal(attempts, 2)
  assert.equal(result.value, 2)
  assert.deepEqual(await storage.transaction('serial', transaction => transaction.get('command', 'counter')), { value: 2 })
})

test('a real opposite-order row lock yields PostgreSQL 40P01', { timeout: 30000 }, async () => {
  const fixture = await database()
  await fixture.client.query('CREATE TABLE conflict_fixture(id integer PRIMARY KEY, value integer); INSERT INTO conflict_fixture VALUES(1, 0), (2, 0)')
  const left = await client(fixture.name)
  const right = await client(fixture.name)
  await left.query('BEGIN')
  await right.query('BEGIN')
  await left.query('SELECT * FROM conflict_fixture WHERE id=1 FOR UPDATE')
  await right.query('SELECT * FROM conflict_fixture WHERE id=2 FOR UPDATE')
  const results = await Promise.allSettled([
    left.query('SELECT * FROM conflict_fixture WHERE id=2 FOR UPDATE'),
    right.query('SELECT * FROM conflict_fixture WHERE id=1 FOR UPDATE'),
  ])
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason?.code === '40P01').length, 1,
    JSON.stringify(results))
  await left.query('ROLLBACK').catch(() => {})
  await right.query('ROLLBACK').catch(() => {})
})

test('a PostgreSQL deadlock retries the full public command transaction', { timeout: 30000 }, async () => {
  const { storage, database: name } = await newStorage()
  const raw = await client(name)
  await raw.query(`CREATE TABLE deadlock_fixture(id integer PRIMARY KEY, value integer);
    INSERT INTO deadlock_fixture VALUES(1, 0), (2, 0);
    CREATE FUNCTION lock_deadlock_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM 1 FROM deadlock_fixture WHERE id=NEW.id::int FOR UPDATE; RETURN NEW; END $$;
    CREATE TRIGGER lock_deadlock_fixture BEFORE INSERT ON ds_superagent_records
      FOR EACH ROW WHEN (NEW.kind='command' AND NEW.id IN ('1','2')) EXECUTE FUNCTION lock_deadlock_fixture()`)
  let arrivals = 0
  let openBarrier
  const barrier = new Promise(resolve => { openBarrier = resolve })
  const attempts = new Map()
  const run = (instanceId, first, second) => commandTransaction(storage, instanceId, async transaction => {
    const attempt = (attempts.get(instanceId) ?? 0) + 1
    attempts.set(instanceId, attempt)
    await transaction.insert('command', String(first), { attempt })
    if (attempt === 1) {
      arrivals++
      if (arrivals === 2) openBarrier()
      await barrier
    }
    await transaction.insert('command', String(second), { attempt })
    return attempt
  })
  const results = await Promise.all([run('deadlock-left', 1, 2), run('deadlock-right', 2, 1)])
  assert.deepEqual([...attempts.values()].sort(), [1, 2])
  assert.deepEqual(results.sort(), [1, 2])
})

test('the command retry budget reruns a whole transaction after DEADLOCK', { timeout: 30000 }, async () => {
  let attempts = 0
  const fake = {
    async transaction() {
      attempts++
      if (attempts < 2) throw new CoreError('DEADLOCK', 'The transaction was a deadlock victim.')
      return 'retried'
    },
    async reconnect() { return fake },
    async close() {},
  }
  assert.equal(await commandTransaction(fake, 'fake', async () => 'ignored'), 'retried')
  assert.equal(attempts, 2)
})

test('an over-new or orphaned PostgreSQL schema is rejected without mutation', { timeout: 30000 }, async () => {
  const future = await database()
  await future.client.query('CREATE TABLE ds_superagent_meta(key text PRIMARY KEY, value text NOT NULL); INSERT INTO ds_superagent_meta VALUES(\'schema_version\', \'99\')')
  await assert.rejects(PostgresStorage.open({ ...configuration, database: future.name }), { code: 'UNSUPPORTED_SCHEMA' })
  assert.equal((await future.client.query("SELECT value FROM ds_superagent_meta WHERE key='schema_version'")).rows[0].value, '99')

  const orphan = await database()
  await orphan.client.query('CREATE TABLE ds_superagent_records(instance_id text, kind text, id text, body jsonb)')
  await assert.rejects(PostgresStorage.open({ ...configuration, database: orphan.name }), { code: 'UNSUPPORTED_SCHEMA' })
})

test('a legacy records table upgrades only after a verified backup', { timeout: 30000 }, async () => {
  const legacy = await database()
  await legacy.client.query(`CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL);
    INSERT INTO records VALUES('legacy', 'command', 'original', '{"receipt":{"status":"pending"}}')`)
  const backupDirectory = join(directory, 'backups')
  const storage = await PostgresStorage.open({ ...configuration, database: legacy.name, backupDirectory })
  postgres.register(storage)
  assert.deepEqual(await storage.transaction('legacy', transaction => transaction.get('command', 'original')),
    { receipt: { status: 'pending' } })
  const version = await legacy.client.query("SELECT value FROM ds_superagent_meta WHERE key='schema_version'")
  assert.equal(version.rows[0].value, '1')
  const upgraded = await legacy.client.query("SELECT to_regclass('public.ds_superagent_legacy_records')::text AS legacy")
  assert.ok(upgraded.rows[0].legacy)
  const backups = (await readdir(backupDirectory)).filter(name => name.includes('.json'))
  assert.equal(backups.length, 1)
  const saved = JSON.parse(await readFile(join(backupDirectory, backups[0]), 'utf8'))
  assert.equal(saved.version, 0)
  assert.equal(saved.records.length, 1)
  assert.equal(saved.records[0].id, 'original')
  const restored = await database()
  await restored.client.query('CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL)')
  for (const row of saved.records) {
    await restored.client.query('INSERT INTO records VALUES($1,$2,$3,$4)', [row.instance_id, row.kind, row.id, row.body])
  }
  const recovery = await PostgresStorage.open({ ...configuration, database: restored.name, backupDirectory: join(directory, 'restore-backups') })
  postgres.register(recovery)
  assert.deepEqual(await recovery.transaction('legacy', transaction => transaction.get('command', 'original')),
    { receipt: { status: 'pending' } })
})

test('a version label cannot authorize an incompatible table layout or key', async () => {
  for (const change of [
    'ALTER TABLE ds_superagent_records DROP COLUMN seq',
    'ALTER TABLE ds_superagent_records DROP CONSTRAINT ds_superagent_records_pkey',
    'ALTER TABLE ds_superagent_records ALTER COLUMN body TYPE text USING body::text',
    'ALTER TABLE ds_superagent_instances DROP CONSTRAINT ds_superagent_instances_pkey',
  ]) {
    const { storage, database: name } = await newStorage()
    await storage.close()
    const raw = await client(name)
    await raw.query(change)
    await assert.rejects(PostgresStorage.open({ ...configuration, database: name }), { code: 'UNSUPPORTED_SCHEMA' })
    assert.equal((await raw.query("SELECT value FROM ds_superagent_meta WHERE key='schema_version'")).rows[0].value, '1')
  }
})

test('an interrupted or failed legacy upgrade leaves the old table and version unchanged', { timeout: 30000 }, async () => {
  const interrupted = await database()
  await interrupted.client.query(`CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL);
    INSERT INTO records VALUES('legacy', 'command', 'original', '{}');
    CREATE TABLE ds_superagent_legacy_records(id integer)`)
  const interruptedBackupDirectory = join(directory, 'interrupted-backups')
  await assert.rejects(PostgresStorage.open({ ...configuration, database: interrupted.name, backupDirectory: interruptedBackupDirectory }))
  assert.equal((await interrupted.client.query("SELECT to_regclass('public.ds_superagent_meta')::text AS meta")).rows[0].meta, null)
  assert.equal((await interrupted.client.query('SELECT count(*)::int AS count FROM records')).rows[0].count, 1)
  assert.equal((await readdir(interruptedBackupDirectory)).some(name => name.endsWith('.json')), true)

  const legacy = await database()
  await legacy.client.query(`CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL);
    INSERT INTO records VALUES('legacy', 'command', 'broken', 'not-json')`)
  const failedBackupDirectory = join(directory, 'failed-backups')
  await assert.rejects(PostgresStorage.open({ ...configuration, database: legacy.name, backupDirectory: failedBackupDirectory }))
  const meta = await legacy.client.query("SELECT to_regclass('public.ds_superagent_meta')::text AS meta")
  assert.equal(meta.rows[0].meta, null)
  const rows = await legacy.client.query('SELECT count(*)::int AS count FROM records')
  assert.equal(rows.rows[0].count, 1)
  assert.equal((await readdir(failedBackupDirectory)).some(name => name.endsWith('.json')), true)
  await legacy.client.query("UPDATE records SET body='{\"receipt\":{\"status\":\"pending\"}}' WHERE id='broken'")
  const storage = await PostgresStorage.open({ ...configuration, database: legacy.name, backupDirectory: failedBackupDirectory })
  postgres.register(storage)
  assert.deepEqual(await storage.transaction('legacy', transaction => transaction.get('command', 'broken')),
    { receipt: { status: 'pending' } })
})

test('the public Engine commands and queries run on PostgreSQL', { timeout: 30000 }, async () => {
  const { storage } = await newStorage()
  const native = await nativeContext(join(directory, 'engine-sessions'), () => textResponse('Recorded.'))
  const sessions = new NativeSessions(native, { router: { provider: 'mock', model: 'router' }, worker: { provider: 'mock', model: 'worker' } })
  const engine = new Engine(storage, 'private', { sourceInstanceId: 'desktop', actorId: 'user', allowedActorIds: ['user'] }, {}, sessions)
  const receipt = await engine.submit({ commandId: 'postgres-submit', eventId: 'postgres-event', text: 'Use the shared backend.' })
  const replay = await engine.submit({ commandId: 'postgres-submit', eventId: 'postgres-event', text: 'Use the shared backend.' })
  assert.deepEqual(replay, receipt)
  await assert.rejects(engine.submit({ commandId: 'postgres-submit', eventId: 'postgres-event', text: 'Different work.' }), { code: 'IDENTITY_CONFLICT' })
  const conversation = await engine.conversation(receipt.ticketId)
  assert.equal(conversation.request, 'Use the shared backend.')
  assert.equal(await storage.transaction('private', transaction => transaction.get('ticket', receipt.ticketId)).then(value => value?.state), 'open')
  await engine.shutdown()
  await sessions.close()
  await native.fiber.dispose()
})

test('connection loss at each migration DDL window preserves legacy data and permits retry', { timeout: 60000 }, async () => {
  for (const table of ['ds_superagent_meta', 'ds_superagent_instances', 'ds_superagent_records', 'ds_superagent_legacy_records']) {
    const fixture = await database()
    await fixture.client.query(`CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL);
      INSERT INTO records VALUES('migration', 'command', 'original', '{"accepted":true}');
      CREATE FUNCTION interrupt_upgrade() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity='public.${table}') THEN
          PERFORM pg_terminate_backend(pg_backend_pid());
        END IF;
      END $$;
      CREATE EVENT TRIGGER interrupt_upgrade ON ddl_command_end EXECUTE FUNCTION interrupt_upgrade()`)
    const backupDirectory = join(directory, `interrupted-${table}`)
    await assert.rejects(PostgresStorage.open({ ...configuration, database: fixture.name, backupDirectory }))
    assert.equal((await fixture.client.query("SELECT to_regclass('public.ds_superagent_meta')::text AS meta")).rows[0].meta, null)
    assert.equal((await fixture.client.query('SELECT body FROM records')).rows[0].body, '{"accepted":true}')
    assert.equal((await readdir(backupDirectory)).some(name => name.endsWith('.json')), true)
    await fixture.client.query('DROP EVENT TRIGGER interrupt_upgrade')
    const storage = await PostgresStorage.open({ ...configuration, database: fixture.name, backupDirectory })
    postgres.register(storage)
    assert.deepEqual(await storage.transaction('migration', transaction => transaction.get('command', 'original')), { accepted: true })
  }
})

test('migration COMMIT loss is resolved by reopening the same database', { timeout: 30000 }, async () => {
  for (const mode of ['before-commit', 'after-commit']) {
    const fixture = await database()
    await fixture.client.query(`CREATE TABLE records(instance_id text NOT NULL, kind text NOT NULL, id text NOT NULL, body text NOT NULL);
      INSERT INTO records VALUES('migration', 'command', 'original', '{}')`)
    const proxy = await commitProxy(port, mode)
    proxies.push(proxy)
    proxy.arm()
    const backupDirectory = join(directory, `migration-${mode}`)
    await assert.rejects(PostgresStorage.open({ ...configuration, database: fixture.name, port: proxy.port, backupDirectory }))
    const storage = await PostgresStorage.open({ ...configuration, database: fixture.name, backupDirectory })
    postgres.register(storage)
    assert.deepEqual(await storage.transaction('migration', transaction => transaction.get('command', 'original')), {})
  }
})

test('old Effect results cannot replace a newer payload on PostgreSQL', { timeout: 30000 }, async () => {
  const { storage } = await newStorage()
  for (const type of ['success', 'transient', 'defer', 'permanent']) {
    const entered = gate(), release = gate()
    const effects = new Effects(storage, `effect-${type}`, { handlers: { notice: { execute: async () => {
      entered.resolve()
      await release.promise
      return type === 'success' ? { type } : { type, reason: 'old result' }
    } } } })
    const enqueue = payload => storage.transaction(`effect-${type}`, transaction => effects.enqueue(transaction,
      { key: 'replace', stream: 'notice', scope: 'router', payload }))
    const original = await enqueue({ revision: 1 })
    const running = effects.drain()
    await entered.promise
    const updated = await enqueue({ revision: 2 })
    release.resolve()
    await running
    assert.notEqual(updated.generation, original.generation)
    assert.equal((await effects.receipt(original.id, original.generation)).state, 'superseded')
    const current = (await effects.list()).items[0]
    assert.equal(current.generation, updated.generation)
    assert.equal(current.attempts, 0)
    await effects.stop()
  }
})

test('PostgreSQL statement and three-attempt budgets stop without accepting partial work', { timeout: 30000 }, async () => {
  const { storage, database: name } = await newStorage({ statementTimeoutMs: 100, lockTimeoutMs: 1000 })
  const raw = await client(name)
  await raw.query(`CREATE FUNCTION slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$;
    CREATE TRIGGER slow_insert BEFORE INSERT ON ds_superagent_records FOR EACH ROW EXECUTE FUNCTION slow_insert()`)
  await assert.rejects(commandTransaction(storage, 'budget', transaction => transaction.insert('command', 'slow', {})), { code: 'STATEMENT_TIMEOUT' })
  assert.equal(await storage.transaction('budget', transaction => transaction.get('command', 'slow')), undefined)
  await raw.query(`DROP TRIGGER slow_insert ON ds_superagent_records;
    CREATE FUNCTION serial_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'serialization failure fixture' USING ERRCODE='40001'; END $$;
    CREATE TRIGGER serial_failure BEFORE INSERT ON ds_superagent_records FOR EACH ROW EXECUTE FUNCTION serial_failure()`)
  let attempts = 0
  await assert.rejects(commandTransaction(storage, 'budget', async transaction => {
    attempts++
    await transaction.insert('command', 'retry', {})
  }), { code: 'RETRY_EXHAUSTED' })
  assert.equal(attempts, 3)
  assert.equal(await storage.transaction('budget', transaction => transaction.get('command', 'retry')), undefined)
})

test('server-confirmed COMMIT failures keep their classification instead of becoming unknown', { timeout: 30000 }, async () => {
  const { storage, database: name } = await newStorage()
  const raw = await client(name)
  await raw.query(`CREATE SEQUENCE commit_attempt;
    CREATE FUNCTION fail_commit_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('commit_attempt')=1 THEN RAISE EXCEPTION 'serialization at commit' USING ERRCODE='40001'; END IF;
      RETURN NEW;
    END $$;
    CREATE CONSTRAINT TRIGGER fail_commit_once AFTER INSERT ON ds_superagent_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit_once()`)
  let attempts = 0
  await commandTransaction(storage, 'commit-error', async transaction => {
    attempts++
    await transaction.insert('command', 'one', {})
  })
  assert.equal(attempts, 2)
  await raw.query(`DROP TRIGGER fail_commit_once ON ds_superagent_records;
    CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'duplicate at commit' USING ERRCODE='23505'; END $$;
    CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON ds_superagent_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_commit()`)
  attempts = 0
  await assert.rejects(commandTransaction(storage, 'commit-error', async transaction => {
    attempts++
    await transaction.insert('command', 'duplicate', {})
  }), { code: 'RECORD_EXISTS' })
  assert.equal(attempts, 1)
})

test('declared pool capacity handles bounded parallel command load', { timeout: 30000 }, async context => {
  const { storage } = await newStorage({ maxConnections: 4 })
  const timings = []
  const started = performance.now()
  await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const began = performance.now()
    await commandTransaction(storage, `load-${index % 4}`, transaction => transaction.insert('command', `load-${index}`, { index }))
    timings.push(performance.now() - began)
  }))
  timings.sort((left, right) => left - right)
  assert.equal((await storage.transaction('load-0', transaction => transaction.list('command', 100))).length, 8)
  context.diagnostic(`32 commands / 4 Instances / 4 connections: total=${(performance.now() - started).toFixed(1)}ms, p50=${timings[15].toFixed(1)}ms, p95=${timings[30].toFixed(1)}ms, max=${timings[31].toFixed(1)}ms; lock=1500ms, statement=4000ms, attempts<=3`)
})
