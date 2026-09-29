// Builders for OpenAI chat-completion stream frames (test infrastructure only).

export const text = (content: string) => ({ choices: [{ index: 0, delta: { content } }] })
export const reasoning = (content: string) => ({ choices: [{ index: 0, delta: { reasoning_content: content } }] })
export const toolStart = (index: number, id: string, name: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] } }] })
export const toolArgs = (index: number, fragment: string) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: fragment } }] } }] })
export const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
export const usage = (prompt: number, completion: number) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })
export const errorFrame = (message: string, code: number) => ({ error: { message, code } })

/** Split a string into `parts` roughly equal fragments. */
export function fragments(value: string, parts: number): string[] {
  const size = Math.ceil(value.length / parts)
  const out: string[] = []
  for (let offset = 0; offset < value.length; offset += size) out.push(value.slice(offset, offset + size))
  return out
}

/** Frames for one complete streamed tool call with fragmented arguments. */
export function toolCallFrames(index: number, id: string, name: string, args: unknown, parts = 4): unknown[] {
  return [toolStart(index, id, name), ...fragments(JSON.stringify(args), parts).map(fragment => toolArgs(index, fragment))]
}
