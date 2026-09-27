import { agentIds, effortSchema, harnessSchema, permissionSchema } from './schema'

// Every key `konvoy config set` takes, with what it does and, where the schema allows only a few,
// the values themselves. `/config set` offers these as a list, and a key typed wrong is answered
// with the ones it was probably meant to be: "Unrecognized key: permission" named the problem and
// none of the three keys that would have worked. tests/config.test.ts writes every key here
// through the schema, so the list cannot name a key the schema does not have.

export interface ConfigKey {
  key: string
  summary: string
  /** the values it takes, when the schema allows only a few */
  values?: readonly string[]
  /** only the global config may set it (src/config/load.ts ignores it in a project file) */
  privileged?: boolean
  /** a value that parses, for a key whose values are open */
  example?: string
}

const BOOL = ['true', 'false'] as const

function agentKeys(id: string): ConfigKey[] {
  return [
    { key: `agents.${id}.model`, summary: `the model ${id} runs`, example: 'some-model' },
    { key: `agents.${id}.effort`, summary: `how hard ${id} thinks`, values: effortSchema.options },
    { key: `agents.${id}.permission`, summary: `what ${id} may do without asking`, values: permissionSchema.options, privileged: true },
    { key: `agents.${id}.harness`, summary: `how much of ${id}'s own setup a turn loads`, values: harnessSchema.options, privileged: true },
    { key: `agents.${id}.bin`, summary: `the ${id} binary, when it is not on PATH`, privileged: true, example: '/usr/local/bin/x' },
    { key: `agents.${id}.enabled`, summary: `whether ${id} is in the convoy`, values: BOOL },
    { key: `agents.${id}.style`, summary: `brief answers from ${id}, or null for its own`, values: ['brief', 'null'] },
  ]
}

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: 'defaults.effort', summary: 'how hard every agent thinks, unless it sets its own', values: effortSchema.options },
  { key: 'defaults.permission', summary: 'what every agent may do without asking', values: permissionSchema.options, privileged: true },
  { key: 'defaults.harness', summary: "how much of each CLI's own setup a turn loads", values: harnessSchema.options, privileged: true },
  { key: 'defaults.style', summary: 'brief answers from every agent', values: ['brief', 'null'] },
  ...agentIds.flatMap(agentKeys),
  { key: 'roles.lead', summary: 'the agent a new session starts with', values: agentIds },
  { key: 'roles.reviewer', summary: 'the agent a handoff to "reviewer" reaches', values: agentIds },
  { key: 'roles.implementer', summary: 'the agent a handoff to "implementer" reaches', values: agentIds },
  { key: 'roles.researcher', summary: 'the agent a handoff to "researcher" reaches', values: agentIds },
  { key: 'failover.chain', summary: 'agents to move through when one runs out, as JSON: ["codex","claude"]', example: '["codex","claude"]' },
  { key: 'failover.upstreamRetries', summary: 'retries on the same agent for an upstream error, 0 to 10', example: '3' },
  { key: 'delegation.enabled', summary: 'let agents hand work to each other', values: BOOL },
  { key: 'gate.command', summary: 'a check run after each turn that produced something', privileged: true, example: 'bun test' },
  { key: 'policy.turnTimeoutSec', summary: 'seconds a turn may run before it is stopped', example: '900' },
]

const byKey = new Map(CONFIG_KEYS.map((k) => [k.key, k]))

export function configKey(key: string): ConfigKey | undefined {
  return byKey.get(key)
}

/** a key konvoy knows, or a whole section of them (`agents.claude`, `failover`), or pricing */
export function knownKey(key: string): boolean {
  if (byKey.has(key) || key === 'pricing' || key.startsWith('pricing.')) return true
  return CONFIG_KEYS.some((k) => k.key.startsWith(`${key}.`))
}

// The keys a mistyped one was probably meant to be: every key whose last part is what was typed
// (`permission` is defaults.permission and each agents.<id>.permission, shown once as a pattern),
// then keys a letter or two away.
export function keysLike(typed: string): string[] {
  const last = typed.split('.').at(-1) ?? typed
  const sameLeaf = CONFIG_KEYS.filter((k) => k.key.split('.').at(-1) === last).map((k) => k.key)
  const perAgent = sameLeaf.filter((k) => k.startsWith('agents.'))
  const collapsed = [...sameLeaf.filter((k) => !k.startsWith('agents.')), ...(perAgent.length > 0 ? [`agents.<agent>.${last}`] : [])]
  if (collapsed.length > 0) return collapsed
  const near = CONFIG_KEYS.filter((k) => distance(typed, k.key) <= 2).map((k) => k.key)
  return near.slice(0, 3)
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}
