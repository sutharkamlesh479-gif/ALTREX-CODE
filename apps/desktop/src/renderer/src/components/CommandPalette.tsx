import { useState } from 'react'
import { MessageSquare, Search } from 'lucide-react'
import { commandItems } from '../product'
import { getConversationTitle } from '../local-conversation'
import type { AltrexController } from '../useAltrex'
import { Dialog } from './primitives'

export function CommandPalette({ app }: { app: AltrexController }) {
  const [query, setQuery] = useState('')
  const entries = [
    ...commandItems.map(item => ({ label: item.label, detail: item.detail as string, icon: item.icon, run: () => app.runCommand(item.action) })),
    ...app.history.filter(entry => entry.projectPath === (app.project?.path ?? null)).map(entry => ({ label: getConversationTitle(entry.messages) ?? 'Conversation', detail: 'Recent conversation', icon: MessageSquare, run: () => { app.setCommandOpen(false); app.restoreConversation(entry) } })),
  ].filter(entry => `${entry.label} ${entry.detail}`.toLowerCase().includes(query.toLowerCase()))
  return <Dialog title="Search and commands" onClose={() => app.setCommandOpen(false)} className="command-palette"><div onKeyDown={event => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.command-result')]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
    if (event.key === 'Enter' && document.activeElement?.tagName === 'INPUT') { event.preventDefault(); entries[0]?.run() }
  }}><label className="command-input"><Search size={18} /><input data-autofocus aria-label="Search conversations and commands" placeholder="Search conversations and commands…" value={query} onChange={event => setQuery(event.target.value)} /><kbd>Esc</kbd></label><div className="command-results">{entries.map(({ label, detail, icon: Icon, run }, index) => <button className="command-result" key={`${label}-${index}`} onClick={run}><Icon size={17} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}{!entries.length && <p className="empty-small">No results for “{query}”</p>}</div><div className="palette-footer">↑ ↓ to navigate <span>Enter to open</span></div></div></Dialog>
}
