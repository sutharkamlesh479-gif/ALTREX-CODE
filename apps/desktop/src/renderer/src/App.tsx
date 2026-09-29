import { useEffect, useState } from 'react'
import { FileCode2, Folder, GitBranch, Search, Settings, X, Info } from 'lucide-react'
import { useAltrex } from './useAltrex'
import { Sidebar } from './components/Sidebar'
import { HomeScreen } from './components/HomeScreen'
import { Composer } from './components/Composer'
import { ChatView, OutputPanel } from './components/ChatView'
import { SettingsDialog } from './components/SettingsDialog'
import { ProviderDialog } from './components/ProviderDialog'
import { CommandPalette } from './components/CommandPalette'
import { IconButton } from './components/primitives'

export function App(): React.JSX.Element {
  const app = useAltrex()
  const [outputOpen, setOutputOpen] = useState(false)
  const hasResults = app.messages.some(message => message.files?.length || message.commands?.length)
  useEffect(() => { setOutputOpen(false) }, [app.conversationId])
  return <div className={`app-shell ${app.sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
    <Sidebar app={app} />
    <header className="topbar"><div className="workspace-heading"><Folder size={15} /><span title={app.project?.path}>{app.project?.name ?? 'Your workspace'}</span>{app.project?.branch && <span className="branch"><GitBranch size={12} />{app.project.branch}</span>}<span className="top-divider" /><span className="conversation-title">{app.conversationTitle ?? 'New chat'}</span></div><div className="topbar-actions">{hasResults && <button className={`results-trigger ${outputOpen ? 'selected' : ''}`} aria-expanded={outputOpen} onClick={() => setOutputOpen(!outputOpen)}><FileCode2 size={15} /><span>Results</span></button>}<IconButton label="Search and commands" onClick={() => app.setCommandOpen(true)}><Search size={16} /></IconButton><IconButton label="Settings" onClick={() => app.setSettingsOpen(true)}><Settings size={16} /></IconButton></div></header>
    <main className={`main-canvas ${outputOpen && hasResults ? 'with-output' : ''}`}><div className="workspace-content">{app.messages.length ? <ChatView app={app} /> : <HomeScreen onPrompt={prompt => { app.setPrompt(prompt); app.focusComposer() }} />}<Composer app={app} /></div>{outputOpen && hasResults && <OutputPanel app={app} onClose={() => setOutputOpen(false)} />}</main>
    {app.notice && <div className="notice" role="status"><Info size={16} /><span>{app.notice}</span><IconButton label="Dismiss notification" onClick={() => app.setNotice(null)}><X size={14} /></IconButton></div>}
    {app.settingsOpen && <SettingsDialog app={app} />}
    {app.connectOpen && <ProviderDialog app={app} />}
    {app.commandOpen && <CommandPalette app={app} />}
  </div>
}
