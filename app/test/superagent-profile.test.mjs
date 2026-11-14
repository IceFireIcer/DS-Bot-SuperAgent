import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the real ds-superagent profile boots Main and verifies delegated local work', { timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ['scripts/check-superagent-profile.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1))
  assert.equal(result.profile, 'ds-superagent')
  for (const service of ['superagentProduct', 'webServer', 'connection', 'sessionPersistence']) {
    assert.ok(result.services.includes(service), `${service} is mounted`)
  }
  assert.equal(result.messages, 4)
  assert.equal(result.localWorkStatus, 'success')
  assert.equal(result.localWorkItems, 2)
  assert.equal(result.nativeSessionAccessDenied, true)
})
