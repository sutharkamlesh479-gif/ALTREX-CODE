export type LocalCodingModel = {
  id: string
  name: string
  description: string
  downloadSize: string
  contextWindow: string
  license: string
  hardwareFit: string
}

export const recommendedLocalCodingModel: LocalCodingModel = {
  id: 'qwen2.5-coder:7b-instruct',
  name: 'Qwen2.5-Coder 7B Instruct',
  description: 'A strong open coding model for generation, reasoning, repair, and repository tools.',
  downloadSize: '4.7 GB',
  contextWindow: '32K',
  license: 'Apache 2.0',
  hardwareFit: 'Recommended for 16 GB RAM and 8 GB VRAM',
}

export const recommendedLocalVisionModel: LocalCodingModel = {
  id: 'qwen2.5vl:3b',
  name: 'Qwen2.5-VL 3B',
  description: 'Local screenshot, interface, document, chart, and image understanding for the coding agent.',
  downloadSize: '3.2 GB',
  contextWindow: '125K',
  license: 'Apache 2.0',
  hardwareFit: 'Recommended local vision companion for 16 GB RAM',
}

export const approvedLocalModels = [recommendedLocalCodingModel, recommendedLocalVisionModel] as const

export function isApprovedLocalModel(modelId: string): boolean {
  return approvedLocalModels.some(model => model.id === modelId)
}

export function isApprovedLocalVisionModel(modelId: string): boolean {
  return modelId === recommendedLocalVisionModel.id
}
