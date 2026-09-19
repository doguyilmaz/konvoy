import { z } from 'zod'

export const agentIds = ['claude', 'codex', 'kiro', 'opencode'] as const
export const effortSchema = z.enum(['low', 'medium', 'high', 'max'])
export const permissionSchema = z.enum(['safe', 'edit', 'yolo'])
export const harnessSchema = z.enum(['minimal', 'inherit'])
export const agentIdSchema = z.enum(agentIds)

const agentConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    effort: effortSchema.optional(),
    permission: permissionSchema.optional(),
    harness: harnessSchema.optional(),
    bin: z.string().optional(),
    subagentEffort: effortSchema.optional(),
    engine: z.string().optional(),
  })
  .strict()

const defaultsObjectSchema = z
  .object({
    effort: effortSchema.default('high'),
    permission: permissionSchema.default('edit'),
    harness: harnessSchema.default('minimal'),
  })
  .strict()

export const configSchema = z
  .object({
    defaults: defaultsObjectSchema
      .catch({ effort: 'high', permission: 'edit', harness: 'minimal' })
      .pipe(defaultsObjectSchema),
    agents: z.partialRecord(agentIdSchema, agentConfigSchema).default({}),
    roles: z
      .object({
        lead: agentIdSchema.optional(),
        implementer: agentIdSchema.optional(),
        reviewer: agentIdSchema.optional(),
        researcher: agentIdSchema.optional(),
      })
      .strict()
      .default({}),
    policy: z
      .object({
        maxDelegationDepth: z.number().int().positive().default(3),
        turnTimeoutSec: z.number().int().positive().default(900),
        isolation: z.enum(['serial', 'parallel']).default('serial'),
      })
      .strict()
      .default({}),
  })
  .strict()

export type Config = z.infer<typeof configSchema>
export type AgentId = z.infer<typeof agentIdSchema>
export type Effort = z.infer<typeof effortSchema>
export type Permission = z.infer<typeof permissionSchema>
export type Harness = z.infer<typeof harnessSchema>
