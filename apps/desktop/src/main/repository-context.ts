import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { RepositoryIntelligence } from '@altrex/core/repo/intelligence'
import { renderRetrievedContext, retrieveContext } from '@altrex/core/context/retrieval'

// Repository context for model requests (V4 Phase 5): task-driven retrieval with provenance instead of
// a keyword-scored dump. The request budgeter treats this text as optional context and compacts it to
// each model's real context window, so the retrieval budget can be generous.

const intelligence = new Map<string, RepositoryIntelligence>()

/** Cached repository intelligence per project (index refreshed after 30 s). */
export function repositoryIntelligence(projectPath: string): RepositoryIntelligence {
  let key: string
  try { key = realpathSync(projectPath) } catch { key = projectPath }
  let existing = intelligence.get(key)
  if (!existing) {
    existing = new RepositoryIntelligence(key)
    intelligence.set(key, existing)
    if (intelligence.size > 16) intelligence.delete(intelligence.keys().next().value as string)
  }
  return existing
}

export function buildRepositoryContext(projectPath: string, task = '', maxCharacters = 40_000): string {
  const intel = repositoryIntelligence(projectPath)
  intel.refresh() // the agent may have changed files since the last request
  return renderRetrievedContext(basename(projectPath), retrieveContext(intel, task, { maxChars: maxCharacters }))
}
