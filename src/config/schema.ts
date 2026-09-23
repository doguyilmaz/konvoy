import { z } from 'zod'

export const agentIds = ['claude', 'codex', 'kiro', 'opencode', 'antigravity'] as const
export const effortSchema = z.enum(['low', 'medium', 'high', 'max'])
// safe -> edit -> auto -> yolo. `auto` exists because a headless turn cannot answer a prompt:
// claude and codex both have a mode that reviews a call automatically instead of refusing it.
export const permissionSchema = z.enum(['safe', 'edit', 'auto', 'yolo'])
export const harnessSchema = z.enum(['minimal', 'inherit'])
export const agentIdSchema = z.enum(agentIds)
// konvoy's own instruction, not a model capability - `.nullish()` so a per-agent `null` can
// opt out of a `defaults.style` of 'brief', which a plain `.optional()` cannot express.
export const styleSchema = z.enum(['brief'])

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
    style: styleSchema.nullish(),
  })
  .strict()

const defaultsObjectSchema = z
  .object({
    effort: effortSchema.default('high'),
    permission: permissionSchema.default('edit'),
    harness: harnessSchema.optional(),
    style: styleSchema.nullish(),
  })
  .strict()

const rolesObjectSchema = z
  .object({
    lead: agentIdSchema.optional(),
    implementer: agentIdSchema.optional(),
    reviewer: agentIdSchema.optional(),
    researcher: agentIdSchema.optional(),
  })
  .strict()

const MAX_TURN_TIMEOUT_SEC = 24 * 60 * 60

const policyObjectSchema = z
  .object({
    maxDelegationDepth: z.number().int().positive().default(3),
    // A project config sets this, so it is clamped rather than trusted outright - otherwise a
    // hostile repo could make konvoy wait forever on every turn.
    turnTimeoutSec: z
      .number()
      .int()
      .positive()
      .default(900)
      .transform((v) => Math.min(v, MAX_TURN_TIMEOUT_SEC)),
    isolation: z.enum(['serial', 'parallel']).default('serial'),
  })
  .strict()

// An empty chain means the feature is off, which is the default. A project layer may set
// this: naming an ordering among agents the user already enabled grants nothing new, unlike
// `bin` or `permission`.
const failoverObjectSchema = z
  .object({
    chain: z.array(agentIdSchema).default([]),
    upstreamRetries: z.number().int().min(0).max(10).default(3),
  })
  .strict()

export const configSchema = z
  .object({
    defaults: defaultsObjectSchema.prefault({}),
    agents: z.partialRecord(agentIdSchema, agentConfigSchema).default({}),
    roles: rolesObjectSchema.prefault({}),
    policy: policyObjectSchema.prefault({}),
    // The command konvoy runs after a turn to produce a pass/fail verdict on the work - a
    // project layer may never set this; see stripProjectPrivileges in config/load.ts.
    gate: z.object({ command: z.string().nullish() }).strict().prefault({}),
    failover: failoverObjectSchema.prefault({}),
    // Off by default: a single-agent session has no handoff to describe, and asking for one
    // anyway would cost output tokens on every turn for a format nobody reads.
    delegation: z.object({ enabled: z.boolean().default(false) }).strict().prefault({}),
    pricing: z
      .object({
        asOf: z.string().default(''),
        models: z.record(z.string(), z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }).strict()).default({}),
        credits: z.record(z.string(), z.object({ usdPerCredit: z.number() }).strict()).default({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()

export type Config = z.infer<typeof configSchema>
export type AgentId = z.infer<typeof agentIdSchema>
export type Effort = z.infer<typeof effortSchema>
export type Permission = z.infer<typeof permissionSchema>
export type Harness = z.infer<typeof harnessSchema>
export type Style = z.infer<typeof styleSchema>
