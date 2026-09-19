import type { AgentId } from '../types'
import type { Adapter } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { kiroAdapter } from './kiro'
import { opencodeAdapter } from './opencode'

export const adapters: Record<AgentId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kiro: kiroAdapter,
  opencode: opencodeAdapter,
}

export function getAdapter(id: AgentId): Adapter {
  return adapters[id]
}

export const agentIds = Object.keys(adapters) as AgentId[]
export type { Adapter }
