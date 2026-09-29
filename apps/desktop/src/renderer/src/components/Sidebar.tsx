import { useState } from 'react'
import { ChevronDown, Folder, FolderOpen, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, SquarePen } from 'lucide-react'
import { AltrexLogo } from '../AltrexBrand'
import type { AltrexController } from '../useAltrex'
import { getConversationTitle } from '../local-conversation'
import { IconButton } from './primitives'

export function Sidebar({ app }: { app: AltrexController }) {
  const [projectsOpen, setProjectsOpen] = useState(true), [historyOpen, setHistoryOpen] = useState(true)
  const currentHistory = app.history.filter(entry => entry.projectPath === (app.project?.path ?? null))
  return <aside className="sidebar" aria-label="ALTREX navigation">
    <div className="sidebar-brand"><AltrexLogo size={25} /><span>ALTREX <small>CODE</small></span></div>
    <nav className="primary-nav" aria-label="Workspace">
      <button title="New chat · Ctrl+N" onClick={app.newTask} disabled={!!app.activeRequestId}><SquarePen size={17} /><span>New chat</span><kbd>Ctrl N</kbd></button>
      <button title="Search conversations and commands · Ctrl+P" onClick={() => app.setCommandOpen(true)}><Search size={17} /><span>Search</span><kbd>Ctrl P</kbd></button>
      <button title="Open project" onClick={() => void app.openProject()} disabled={app.openingProject || !!app.activeRequestId}><FolderOpen size={17} /><span>{app.openingProject ? 'Opening…' : 'Open project'}</span></button>
    </nav>
    <div className="sidebar-scroll">
      <section className="sidebar-section"><div className="section-heading"><button aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}><ChevronDown size={12} className={projectsOpen ? '' : 'closed'} />Projects</button><IconButton label="Open another project" disabled={!!app.activeRequestId} onClick={() => void app.openProject()}><Plus size={14} /></IconButton></div>
        {projectsOpen && (app.project ? <div className="project-item" title={app.project.path}><Folder size={16} /><span>{app.project.name}</span><span className="current-dot" title="Current project" /></div> : <p className="empty-small">Open a folder to start building.</p>)}
      </section>
      <section className="sidebar-section"><div className="section-heading"><button aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><ChevronDown size={12} className={historyOpen ? '' : 'closed'} />Recent conversations</button></div>
        {historyOpen && (currentHistory.length ? currentHistory.map(entry => <button className={`history-item ${entry.id === app.conversationId && app.messages.length ? 'selected' : ''}`} key={entry.id} title={getConversationTitle(entry.messages) ?? 'Conversation'} disabled={!!app.activeRequestId} onClick={() => app.restoreConversation(entry)}><MessageSquare size={14} /><span>{getConversationTitle(entry.messages) ?? 'Conversation'}</span></button>) : <p className="empty-small">Your conversations will appear here.</p>)}
      </section>
    </div>
    <div className="sidebar-footer"><button title="Settings" onClick={() => app.setSettingsOpen(true)}><Settings size={17} /><span>Settings</span></button><button title={app.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={app.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => app.setSidebarCollapsed(!app.sidebarCollapsed)}>{app.sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}<span>Collapse sidebar</span></button></div>
  </aside>
}
