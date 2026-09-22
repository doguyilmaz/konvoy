import type { AgentId } from '../../src/config/schema'
import type { Detection } from '../../src/core/detect'

// Tests that inject a fake adapter inject the agent; the machine's PATH has no say in them.
export const installed = async (agent: AgentId): Promise<Detection> => ({ agent, installed: true, version: null })
