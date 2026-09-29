import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState('Copy')
  return <button className="copy-button" title={state} aria-label={state} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setState('Copied'); window.setTimeout(() => setState('Copy'), 2000) }).catch(() => setState('Copy failed')) }}>{state === 'Copied' ? <Check size={13} /> : <Copy size={13} />}<span>{state}</span></button>
}
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part)
}
function prose(text: string): ReactNode[] {
  return text.split(/\n\s*\n/).filter(Boolean).map((block, index) => {
    if (/^#{1,6} /.test(block)) return <h3 key={index}>{inline(block.replace(/^#{1,6} /, ''))}</h3>
    if (/^(?:[-*] |\d+\. )/.test(block)) return <ul key={index}>{block.split('\n').map((line, i) => <li key={i}>{inline(line.replace(/^(?:[-*] |\d+\. )/, ''))}</li>)}</ul>
    return <p key={index}>{inline(block)}</p>
  })
}
export function MessageContent({ content }: { content: string }) {
  // React renders text safely; model output never becomes raw HTML.
  const parts = content.split(/```/)
  return <div className="message-content">{parts.map((part, index) => {
    if (index % 2 === 0) return <div key={index}>{prose(part)}</div>
    const newline = part.indexOf('\n'), language = newline >= 0 ? part.slice(0, newline).trim() : ''
    const code = newline >= 0 ? part.slice(newline + 1).replace(/\n$/, '') : part
    return <div className="code-block" key={index}><div className="code-head"><span>{language || 'Code'}</span><CopyButton text={code} /></div><pre><code>{code}</code></pre></div>
  })}</div>
}
export { CopyButton }
