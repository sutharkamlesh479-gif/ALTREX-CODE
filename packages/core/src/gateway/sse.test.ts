import { describe, expect, it } from 'vitest'
import { SseParser } from './sse'
import { ToolCallAssembler, offeredToolNames } from './tool-call-assembler'

describe('SseParser', () => {
  const stream = 'data: {"a":1}\n\n: keep-alive\n\nevent: note\ndata: line one\ndata: line two\n\ndata:no-space\n\ndata: [DONE]\n\n'
  const expected = [
    { event: null, data: '{"a":1}' },
    { event: 'note', data: 'line one\nline two' },
    { event: null, data: 'no-space' },
    { event: null, data: '[DONE]' },
  ]

  it('parses events, comments, multi-line data and the optional space', () => {
    const parser = new SseParser()
    expect([...parser.push(stream), ...parser.end()]).toEqual(expected)
  })

  it('produces identical events for every possible chunk boundary', () => {
    for (let split = 1; split < stream.length; split++) {
      const parser = new SseParser()
      expect([...parser.push(stream.slice(0, split)), ...parser.push(stream.slice(split)), ...parser.end()]).toEqual(expected)
    }
  })

  it('accepts CRLF and bare CR line endings, including CRLF split across chunks', () => {
    const crlf = stream.replaceAll('\n', '\r\n'), cr = stream.replaceAll('\n', '\r')
    const parser = new SseParser()
    const index = crlf.indexOf('\r\n') + 1
    expect([...parser.push(crlf.slice(0, index)), ...parser.push(crlf.slice(index)), ...parser.end()]).toEqual(expected)
    const bare = new SseParser()
    expect([...bare.push(cr), ...bare.end()]).toEqual(expected)
  })

  it('dispatches a final event without a trailing blank line at end of stream', () => {
    const parser = new SseParser()
    expect(parser.push('data: tail')).toEqual([])
    expect(parser.end()).toEqual([{ event: null, data: 'tail' }])
  })

  it('rejects an unbounded line as STREAM_MALFORMED', () => {
    expect(() => new SseParser().push('data: ' + 'x'.repeat(1_000_001))).toThrow(expect.objectContaining({ category: 'STREAM_MALFORMED' }))
  })
})

describe('ToolCallAssembler', () => {
  it('reassembles fragmented arguments of interleaved parallel calls in index order', () => {
    const assembler = new ToolCallAssembler()
    assembler.add({ index: 1, id: 'b', function: { name: 'write_file', arguments: '' } })
    assembler.add({ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"pa' } })
    assembler.add({ index: 1, function: { arguments: '{"path":"x","content":' } })
    assembler.add({ index: 0, function: { arguments: 'th":"src/a.ts"}' } })
    assembler.add({ index: 1, function: { arguments: '"hi"}' } })
    expect(assembler.finish(new Set(['read_file', 'write_file']))).toEqual([
      { id: 'a', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
      { id: 'b', name: 'write_file', arguments: '{"path":"x","content":"hi"}' },
    ])
  })

  it('separates index-less calls by id and continues index-less fragments', () => {
    const assembler = new ToolCallAssembler()
    assembler.add({ id: 'one', function: { name: 'list_files', arguments: '{}' } })
    assembler.add({ id: 'two', function: { name: 'read_file', arguments: '{"path":' } })
    assembler.add({ function: { arguments: '"a"}' } })
    expect(assembler.finish().map(call => [call.id, call.arguments])).toEqual([['one', '{}'], ['two', '{"path":"a"}']])
  })

  it('treats empty arguments as {} and synthesizes a missing id', () => {
    const assembler = new ToolCallAssembler()
    assembler.add({ index: 0, function: { name: 'list_files' } })
    expect(assembler.finish()).toEqual([{ id: 'call_0', name: 'list_files', arguments: '{}' }])
  })

  it.each([
    ['incomplete JSON', { index: 0, id: 'x', function: { name: 'read_file', arguments: '{"path": "src/' } }],
    ['non-object arguments', { index: 0, id: 'x', function: { name: 'read_file', arguments: '["a"]' } }],
    ['missing name', { index: 0, id: 'x', function: { arguments: '{}' } }],
    ['unknown tool', { index: 0, id: 'x', function: { name: 'rm_rf', arguments: '{}' } }],
  ])('rejects %s as TOOL_CALL_MALFORMED without releasing any call', (_label, delta) => {
    const assembler = new ToolCallAssembler()
    assembler.add(delta)
    expect(() => assembler.finish(new Set(['read_file']))).toThrow(expect.objectContaining({ category: 'TOOL_CALL_MALFORMED', retryable: false }))
  })

  it('reads offered tool names from OpenAI tool definitions', () => {
    expect(offeredToolNames([{ type: 'function', function: { name: 'a' } }, { nope: true }, null])).toEqual(new Set(['a']))
  })
})
