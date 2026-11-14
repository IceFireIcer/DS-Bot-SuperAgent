import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Daily CI exercises the product loop without replaying every database/process fixture.
// This is a smoke selection, not an assertion that indirect regressions are covered.
export const smokeTests = [
  'effects', 'execution', 'main-conversation', 'main-delegation', 'main-parallel-delegation', 'policy', 'storage',
].map(name => `test/${name}.test.mjs`)

// Central runtime and shared fixture edits are exercised by the product smoke.
// Reverse imports would select almost every integration suite, including slow
// process/remote fixtures that belong to full release validation.
const sharedModules = new Set([
  'dev/native-mock.mjs',
  'src/engine.ts',
  'src/execution.ts',
  'src/index.ts',
  'src/main-conversation.ts',
  'src/model.ts',
  'src/native-sessions.ts',
  'src/work-delegation.ts',
])

export function selectSuperagentTests(paths, tests) {
  const selected = new Set(smokeTests.filter(name => tests.has(name)))
  for (const raw of paths) {
    const path = raw.replaceAll('\\', '/').replace(/^\.\//u, '')
    if (!path.startsWith('superagent/')) continue
    const local = path.slice('superagent/'.length)
    if (tests.has(local)) selected.add(local)
    const name = local.split('/').at(-1).replace(/\.(?:ts|mjs)$/u, '')
    const matching = `test/${name}.test.mjs`
    if (tests.has(matching)) selected.add(matching)
    if (local === 'scripts/test.mjs') selected.add('test/test-runner.test.mjs')
    // The public index is a barrel used by nearly every integration fixture. Its
    // import alone cannot identify a targeted test, so it keeps the smoke set.
    const imported = local.startsWith('src/') && !sharedModules.has(local)
      ? `../dist/${local.slice(4).replace(/\.ts$/u, '.js')}`
      : local.startsWith('test/') ? `./${local.slice(5)}`
        : local.startsWith('dev/') && !sharedModules.has(local) ? `../${local}` : undefined
    if (!imported) continue
    for (const [file, source] of tests) {
      if (source.includes(`'${imported}'`) || source.includes(`"${imported}"`)) selected.add(file)
    }
  }
  return [...selected].filter(name => tests.has(name)).sort()
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const directory = new URL('../superagent/test/', import.meta.url)
  const tests = new Map(readdirSync(directory).filter(name => name.endsWith('.test.mjs'))
    .map(name => [`test/${name}`, readFileSync(new URL(name, directory), 'utf8')]))
  const base = process.env.CI_TEST_BASE
  const paths = !base || /^0+$/u.test(base) ? [] : execFileSync('git', [
    'diff', '--name-only', base, 'HEAD', '--', 'superagent/',
  ], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/u).filter(Boolean)
  const selected = selectSuperagentTests(paths, tests)
  if (!selected.length) throw new Error('No daily smoke tests exist. Refuse to pass an empty test selection.')
  console.log(`Daily Super-agent CI: ${selected.length}/${tests.size} test files. Remaining suites run in full release validation.`)
  console.log(selected.join('\n'))
  const result = spawnSync(process.execPath, ['scripts/test.mjs', ...selected], {
    cwd: fileURLToPath(new URL('../superagent/', import.meta.url)), stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
