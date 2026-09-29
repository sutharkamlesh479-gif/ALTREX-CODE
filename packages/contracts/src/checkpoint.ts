import { z } from 'zod'

export const CheckpointIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Invalid checkpoint ID.')

export const CheckpointSummarySchema = z.object({
  checkpointId: CheckpointIdSchema,
  projectPath: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  label: z.string().min(1).max(200),
  /** `snapshot` = content-addressed file copy; `git` = temp-index commit under refs/altrex (projects over the snapshot limits). */
  kind: z.enum(['snapshot', 'git']),
  createdAt: z.iso.datetime(),
  fileCount: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),
  /** When the task's end state was recorded; null if the task never finished (e.g. app crash). */
  finalizedAt: z.iso.datetime().nullable(),
  /** Files the task changed (known only once finalized). */
  changedByTask: z.int().nonnegative().nullable(),
})
export type CheckpointSummary = z.infer<typeof CheckpointSummarySchema>

/**
 * `task` — revert only files the task changed, skipping files edited after the task finished.
 * `all`  — revert every difference between the checkpoint and the current tree.
 */
export const RestoreScopeSchema = z.enum(['task', 'all'])
export type RestoreScope = z.infer<typeof RestoreScopeSchema>

export const RestoreConflictSchema = z.object({
  path: z.string().min(1),
  reason: z.enum(['modified-after-task', 'changed-during-restore']),
})
export type RestoreConflict = z.infer<typeof RestoreConflictSchema>

export const RestorePlanSchema = z.object({
  checkpointId: CheckpointIdSchema,
  scope: RestoreScopeSchema,
  restore: z.array(z.string()),
  delete: z.array(z.string()),
  conflicts: z.array(RestoreConflictSchema),
})
export type RestorePlan = z.infer<typeof RestorePlanSchema>

export const RestoreResultSchema = z.object({
  checkpointId: CheckpointIdSchema,
  scope: RestoreScopeSchema,
  restored: z.array(z.string()),
  deleted: z.array(z.string()),
  conflicts: z.array(RestoreConflictSchema),
  /** Checkpoint of the tree taken immediately before restoring, so a restore can itself be undone. */
  safetyCheckpointId: CheckpointIdSchema.nullable(),
})
export type RestoreResult = z.infer<typeof RestoreResultSchema>
