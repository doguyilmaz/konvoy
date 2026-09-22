import type { AgentId } from '../../src/config/schema'
import type { Detection } from '../../src/core/detect'

export const installed = async (agent: AgentId): Promise<Detection> => ({ agent, installed: true, version: null })
