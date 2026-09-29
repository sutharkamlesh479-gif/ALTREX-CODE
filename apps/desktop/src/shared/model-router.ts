export type NvidiaModelOption = {
  id: string
  label: string
  specialty: string
}

export const nvidiaCodingModels: ReadonlyArray<NvidiaModelOption> = [
  {
    id: 'qwen/qwen3-coder-480b-a35b-instruct',
    label: 'Qwen3 Coder 480B',
    specialty: 'Feature implementation, frontend, full-stack, and repository-scale code generation',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    label: 'Nemotron 3 Ultra',
    specialty: 'Complex debugging, architecture, security, migrations, and deep reasoning',
  },
  {
    id: 'minimaxai/minimax-m2.7',
    label: 'MiniMax M2.7',
    specialty: 'Fast focused edits, tests, documentation, and routine maintenance',
  },
] as const

export type NvidiaAutoRoute = {
  model: string
  reason: string
}

export type CodingModelCandidates = {
  models: string[]
  reason: string
}

function firstAvailable(preferences: string[], availableModels: readonly string[], fallback: string): string {
  const available = new Set(availableModels)
  return preferences.find((model) => available.size === 0 || available.has(model)) ?? fallback
}

export function selectNvidiaCodingModel(
  prompt: string,
  availableModels: readonly string[],
  fallback = nvidiaCodingModels[0]!.id,
): NvidiaAutoRoute {
  const task = prompt.toLowerCase()
  const deepReasoningTask = /\b(debug|root cause|security|vulnerab|architecture|architect|migration|database|concurr|performance|optimi[sz]|distributed|race condition|memory leak|refactor.*large|review)\b/.test(task)
  if (deepReasoningTask) {
    return {
      model: firstAvailable([
        'nvidia/nemotron-3-ultra-550b-a55b',
        'qwen/qwen3-coder-480b-a35b-instruct',
      ], availableModels, fallback),
      reason: 'complex reasoning, debugging, architecture, or security work',
    }
  }

  const quickTask = /\b(document|readme|comment|rename|format|lint|small fix|simple|unit test|test coverage|boilerplate)\b/.test(task)
  if (quickTask) {
    return {
      model: firstAvailable([
        'minimaxai/minimax-m2.7',
        'qwen/qwen3-coder-480b-a35b-instruct',
      ], availableModels, fallback),
      reason: 'a focused maintenance or documentation task',
    }
  }

  return {
    model: firstAvailable([
      'qwen/qwen3-coder-480b-a35b-instruct',
      'nvidia/nemotron-3-ultra-550b-a55b',
    ], availableModels, fallback),
    reason: 'general feature implementation and repository coding',
  }
}

const nonCodingModel = /\b(whisper|speech|audio|tts|embedding|embed|guard|moderation|safety|rerank)\b/i

function codingModelScore(model: string, task: string): number {
  const id = model.toLowerCase()
  let score = 0
  if (/coder|coding|\bcode\b/.test(id)) score += 120
  if (/qwen/.test(id)) score += 60
  if (/deepseek/.test(id)) score += 58
  if (/nemotron/.test(id)) score += 56
  if (/kimi|moonshot/.test(id)) score += 52
  if (/gpt-oss/.test(id)) score += 50
  if (/glm/.test(id)) score += 48
  if (/minimax/.test(id)) score += 44
  if (/llama-4|llama-3\.3.*70b/.test(id)) score += 42
  if (/mistral|mixtral/.test(id)) score += 35
  if (/tool|agent/.test(id)) score += 25
  if (/:free\b|openrouter\/free\b/.test(id)) score += 150
  if (/\b(image|photo|screenshot|visual|attached.*image)\b/i.test(task) && /vision|vl|omni|multimodal|llama-4|kimi/.test(id)) score += 95

  const deep = /\b(debug|root cause|security|vulnerab|architecture|migration|database|concurr|performance|optimi[sz]|distributed|race condition|memory leak|large refactor|review)\b/i.test(task)
  const quick = /\b(document|readme|comment|rename|format|lint|small fix|simple|unit test|test coverage|boilerplate)\b/i.test(task)
  if (deep) {
    if (/nemotron.*ultra|deepseek.*pro|glm|120b|70b|large/.test(id)) score += 80
    if (/flash|instant|mini|nano|8b/.test(id)) score -= 35
  } else if (quick) {
    if (/flash|instant|mini|nano|small|8b|32b/.test(id)) score += 75
    if (/ultra|550b|480b/.test(id)) score -= 25
  } else {
    if (/coder|deepseek.*flash|kimi|qwen|gpt-oss|glm/.test(id)) score += 65
    if (/versatile/.test(id)) score += 25
  }
  return score
}

function selectGoogleCodingModel(availableModels: readonly string[], fallback: string): CodingModelCandidates {
  const available = new Set(availableModels)
  const preferences = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ].filter(model => available.has(model))
  const stableTextModels = availableModels.filter(model => /^gemini-/i.test(model) && !/(preview|image|audio|tts|live|transcribe|robotics|computer-use|embedding|omni)/i.test(model))
  const models = [...new Set([...preferences, ...stableTextModels, ...availableModels, fallback])]
  return { models, reason: 'a stable Gemini Flash model with broadly available API quota' }
}

export function selectCodingModelCandidates(
  providerId: string,
  prompt: string,
  availableModels: readonly string[],
  fallback: string,
  limit = 4,
): CodingModelCandidates {
  const usable = [...new Set(availableModels)]
    .filter((model) => !nonCodingModel.test(model))
    .sort((left, right) => codingModelScore(right, prompt) - codingModelScore(left, prompt))
  if (providerId === 'google') {
    const route = selectGoogleCodingModel(usable, fallback)
    return { ...route, models: route.models.slice(0, Math.max(1, limit)) }
  }
  const primaryRoute = providerId === 'nvidia'
    ? selectNvidiaCodingModel(prompt, usable, usable[0] ?? fallback)
    : { model: usable[0] ?? fallback, reason: 'the best available coding and tool-capable model' }
  const candidates = [...new Set([primaryRoute.model, ...usable, fallback])].slice(0, Math.max(1, limit))
  return { models: candidates, reason: primaryRoute.reason }
}
