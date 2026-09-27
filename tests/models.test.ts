import { expect, test } from 'bun:test'
import { listModels, modelsFromJson, modelsFromText, nearestModels, type CatalogDeps } from '../src/core/models'

const deps = (outputs: Record<string, { stdout: string; exitCode?: number }>, files: Record<string, string> = {}) => {
  const ran: string[][] = []
  const d: CatalogDeps = {
    run: async (argv) => {
      ran.push(argv)
      const hit = outputs[argv.slice(1).join(' ')]
      return hit ? { stdout: hit.stdout, exitCode: hit.exitCode ?? 0 } : { stdout: '', exitCode: 1 }
    },
    readText: async (path) => files[path.split('/').slice(-2).join('/')] ?? null,
  }
  return { d, ran }
}

test("claude offers its aliases, and says a full model id is accepted too", async () => {
  const c = (await listModels('claude', deps({}).d))!
  expect(c.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku'])
  expect(c.complete).toBe(false)
})

test("codex's list is the one codex cached for the account", async () => {
  const cache = await Bun.file('tests/fixtures/codex-models-cache.json').text()
  const c = (await listModels('codex', deps({}, { '.codex/models_cache.json': cache }).d))!
  expect(c.models.map((m) => m.id)).toContain('gpt-6-astra')
  expect(c.complete).toBe(true)
  expect(await listModels('codex', deps({}).d)).toBeNull()
})

test('opencode lists provider/model per line, for the providers configured', async () => {
  const { d, ran } = deps({ models: { stdout: 'opencode/claude-opus-5-5\nopencode/claude-sonnet-5\nanthropic/claude-haiku-4-5\n' } })
  const c = (await listModels('opencode', d, '/opt/oc'))!
  expect(ran[0]).toEqual(['/opt/oc', 'models'])
  expect(c.models.map((m) => m.id)).toEqual(['opencode/claude-opus-5-5', 'opencode/claude-sonnet-5', 'anthropic/claude-haiku-4-5'])
})

test('kiro and agy are asked for JSON, and read as text when JSON gives nothing', async () => {
  const kiro = await listModels('kiro', deps({ 'chat --list-models --format json': { stdout: JSON.stringify({ models: [{ modelId: 'claude-sonnet-4.5', description: 'balanced' }, { modelId: 'auto' }] }) } }).d)
  // `auto` is kiro's own choice of model (kiro-cli settings chat.defaultModel auto), and JSON names
  // ids outright: only text needs telling a heading from a model
  expect(kiro!.models).toEqual([{ id: 'claude-sonnet-4.5', detail: 'balanced' }, { id: 'auto' }])
  const agy = await listModels(
    'antigravity',
    deps({ 'models --output-format json': { stdout: 'not json', exitCode: 0 }, models: { stdout: 'Available models:\n  gemini-3.6-flash   Gemini 3.6 Flash\n  gemini-3.6-pro     Gemini 3.6 Pro\n' } }).d,
  )
  expect(agy!.models).toEqual([
    { id: 'gemini-3.6-flash', detail: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.6-pro', detail: 'Gemini 3.6 Pro' },
  ])
  // nothing to read at all: no list rather than an empty one
  expect(await listModels('antigravity', deps({}).d)).toBeNull()
})

test('the JSON shapes a model list comes in are all read', () => {
  expect(modelsFromJson(['a-1', 'b-2']).map((m) => m.id)).toEqual(['a-1', 'b-2'])
  expect(modelsFromJson({ data: [{ id: 'm-1', display_name: 'Model One' }] })).toEqual([{ id: 'm-1', detail: 'Model One' }])
  expect(modelsFromJson({ 'gemini-3.6-flash': { name: 'Flash' }, 'gemini-3.6-pro': {} }).map((m) => m.id)).toEqual(['gemini-3.6-flash', 'gemini-3.6-pro'])
  // hidden ones are not offered, a name with a shell metacharacter never is
  expect(modelsFromJson([{ slug: 'shown-1' }, { slug: 'secret-1', visibility: 'hide' }, { slug: 'x; rm -rf ~' }]).map((m) => m.id)).toEqual(['shown-1'])
})

test('text output keeps model ids and drops headings and control bytes', () => {
  expect(modelsFromText('Models\n- claude-opus-4.8  \x1b[2mdefault\x1b[0m\n* gpt-6\nnothing here\n').map((m) => m.id)).toEqual(['claude-opus-4.8', 'gpt-6'])
})

test('a name the list lacks is matched to the ones it was probably meant to be', () => {
  const catalog = { complete: true, source: 's', models: [{ id: 'opencode/claude-opus-5-5' }, { id: 'opencode/claude-sonnet-5' }, { id: 'anthropic/gpt-6' }] }
  expect(nearestModels('opus-5-5', catalog)).toEqual(['opencode/claude-opus-5-5'])
  expect(nearestModels('zzzz', catalog)).toEqual([])
})
