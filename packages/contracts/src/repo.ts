import { z } from 'zod'

const ProjectPath = z.string().min(1).max(4096)
const RelativePath = z.string().min(1).max(1024)

export const ProjectProfileSchema = z.object({
  languages: z.array(z.object({ language: z.string(), files: z.int().nonnegative() })),
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun']).nullable(),
  frameworks: z.array(z.string()),
  testRunner: z.string().nullable(),
  /** Checks declared by the project itself (never invented). */
  commands: z.array(z.object({ kind: z.enum(['build', 'test', 'lint', 'typecheck']), argv: z.array(z.string()).min(1), source: z.string() })),
  manifests: z.array(z.string()),
  monorepo: z.boolean(),
})
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>

export const SearchMatchSchema = z.object({ path: z.string(), line: z.int().positive(), text: z.string() })

export const RepoSearchRequestSchema = z.object({
  projectPath: ProjectPath,
  pattern: z.string().min(1).max(1000),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  word: z.boolean().optional(),
  glob: z.string().max(200).optional(),
  maxResults: z.int().positive().max(2000).optional(),
})
export const RepoSearchResultSchema = z.object({ matches: z.array(SearchMatchSchema), truncated: z.boolean(), engine: z.enum(['ripgrep', 'builtin']) })

export const CodeSymbolSchema = z.object({
  path: z.string(), name: z.string(), line: z.int().positive(), exported: z.boolean(),
  kind: z.enum(['function', 'class', 'interface', 'type', 'enum', 'const', 'method', 'struct', 'trait', 'module']),
})
export const RepoSymbolsRequestSchema = z.object({ projectPath: ProjectPath, path: RelativePath.optional(), name: z.string().min(1).max(200).optional() })
  .refine(value => Boolean(value.path) !== Boolean(value.name), 'Provide exactly one of path (outline a file) or name (find definitions).')

export const RepoRelatedSchema = z.object({ imports: z.array(z.string()), importers: z.array(z.string()), tests: z.array(z.string()) })

/** What the context engine would send for a task: items with provenance (content omitted). */
export const ContextPreviewSchema = z.object({
  seeds: z.array(z.string()),
  items: z.array(z.object({ kind: z.enum(['rules', 'config', 'file', 'snippet', 'test']), path: z.string(), range: z.tuple([z.int().positive(), z.int().positive()]).optional(), reason: z.string(), chars: z.int().nonnegative() })),
})

export const repoCommandSchemas = {
  'repo.profile': { request: z.object({ projectPath: ProjectPath }), response: ProjectProfileSchema },
  'repo.search': { request: RepoSearchRequestSchema, response: RepoSearchResultSchema },
  'repo.symbols': { request: RepoSymbolsRequestSchema, response: z.array(CodeSymbolSchema) },
  'repo.related': { request: z.object({ projectPath: ProjectPath, path: RelativePath }), response: RepoRelatedSchema },
  'context.preview': { request: z.object({ projectPath: ProjectPath, task: z.string().max(20_000), maxChars: z.int().positive().max(400_000).optional() }), response: ContextPreviewSchema },
} as const
