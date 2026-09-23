import type { AgentId } from '../types'
import type { Adapter } from './types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { kiroAdapter } from './kiro'
import { opencodeAdapter } from './opencode'
import { antigravityAdapter } from './antigravity'

export const adapters: Record<AgentId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  kiro: kiroAdapter,
  opencode: opencodeAdapter,
  antigravity: antigravityAdapter,
}

export function getAdapter(id: AgentId): Adapter {
  return adapters[id]
}

export { agentIds } from '../config/schema'
export type { Adapter }
