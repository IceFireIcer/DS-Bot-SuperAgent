import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectSuperagentTests, smokeTests } from './superagent-ci-tests.mjs'

const tests = new Map([
  ...smokeTests.map(name => [name, "import { Engine } from '../dist/index.js'"]),
  ['test/postgres-storage.test.mjs', "import { PostgresStorage } from '../dist/postgres-storage.js'"],
  ['test/host-process.test.mjs', "import { Engine } from '../dist/index.js'; import './process-support.mjs'"],
  ['test/test-runner.test.mjs', ''],
  ['test/session-persistence-postgres.test.mjs', "import { PostgresStorage } from '../dist/postgres-storage.js'"],
])

test('ordinary changes retain the product smoke without every process/database fixture', () => {
  for (const paths of [[], ['superagent/src/index.ts'], ['superagent/src/engine.ts'], ['superagent/package-lock.json']]) {
    assert.deepEqual(selectSuperagentTests(paths, tests), [...smokeTests].sort())
  }
})

test('changed tests and direct source imports add their regression suites even when expensive', () => {
  const selected = selectSuperagentTests(['superagent/src/postgres-storage.ts', 'superagent/test/host-process.test.mjs'], tests)
  assert.deepEqual(selected, [...smokeTests, 'test/host-process.test.mjs', 'test/postgres-storage.test.mjs', 'test/session-persistence-postgres.test.mjs'].sort())
})

test('changed shared helpers and runner code select the corresponding tests', () => {
  assert.deepEqual(selectSuperagentTests(['superagent/test/process-support.mjs', 'superagent/scripts/test.mjs'], tests),
    [...smokeTests, 'test/host-process.test.mjs', 'test/test-runner.test.mjs'].sort())
})

test('central runtime and shared mock edits do not pull every reverse import into daily CI', () => {
  const broad = new Map(tests)
  broad.set('test/product-scenario.test.mjs', "import { Engine } from '../dist/index.js'")
  broad.set('test/native-integration.test.mjs', "import { nativeContext } from '../dev/native-mock.mjs'")
  assert.deepEqual(selectSuperagentTests([
    'superagent/src/engine.ts', 'superagent/src/index.ts', 'superagent/src/model.ts',
    'superagent/src/native-sessions.ts', 'superagent/dev/native-mock.mjs',
  ], broad), [...smokeTests].sort())
})

test('selection normalizes Windows paths, deduplicates and excludes removed files', () => {
  assert.deepEqual(selectSuperagentTests(['superagent\\src\\storage.ts', 'superagent/src/storage.ts', 'superagent/test/deleted.test.mjs'], tests), [...smokeTests].sort())
})
