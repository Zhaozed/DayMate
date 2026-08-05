// Zod schemas for validating external and model outputs.
// Spec §5: "Validation: Zod; TypeBox only where required by Pi tools."
// Spec §11: "Tool Registry validates every parameter."
// Milestone 0 only ships the foundational schemas; provider/tool schemas land
// in Milestones 1-2.

import { z } from 'zod'
import { ROBOT_STATES } from './constants'

export const robotStateSchema = z.enum(ROBOT_STATES)
export type RobotStateZod = z.infer<typeof robotStateSchema>

// Minimal app-info schema — used to validate data crossing the IPC boundary.
export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string()
})
