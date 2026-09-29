import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderOpen, Paperclip, Plus, ShieldCheck, Square, X } from 'lucide-react'
import type { AltrexController } from '../useAltrex'
import { IconButton, SelectMenu } from './primitives'

export function Composer({ app }: { app: AltrexController }) {
  const [attachOpen, setAttachOpen] = useState(false)
  const attachRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const textarea = app.composerRef.current
    if (textarea) { textarea.style.height = '0px'; textarea.style.height = `${Math.min(200, Math.max(64, textarea.scrollHeight))}px` }
  }, [app.prompt, app.composerRef])
  useEffect(() => {
    if (!attachOpen) return
    const outside = (event: PointerEvent) => { if (!attachRef.current?.contains(event.target as Node)) setAttachOpen(false) }
    document.addEventListener('pointerdown', outside)
    attachRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('pointerdown', outside)
  }, [attachOpen])
  const running = app.activeRequestId !== null
  return <div className="composer-dock"><section className="composer-wrap" aria-label="ALTREX task composer">
    <button className="composer-project" title={app.project?.path ?? 'Select a local project folder'} onClick={() => void app.openProject()} disabled={running || app.openingProject}><Folder size={14} /><span>{app.project?.name ?? 'Choose a project'}</span><span className="project-location">{app.project ? 'Local workspace' : 'Open a folder to use Agent'}</span></button>
    <div className="composer-body">
      {!!app.attachments.length && <div className="attachment-tray" aria-label="Attached files">{app.attachments.map(file => <div className="attachment-preview" key={file.id}>{file.previewDataUrl ? <img src={file.previewDataUrl} alt={file.name} /> : <Paperclip size={15} />}<span title={file.name}>{file.name}</span><IconButton label={`Remove ${file.name}`} onClick={() => app.setAttachments(current => current.filter(item => item.id !== file.id))}><X size={12} /></IconButton></div>)}</div>}
      <textarea ref={app.composerRef} aria-label="Ask ALTREX" placeholder="What do you want ALTREX to do?" value={app.prompt} rows={2} onChange={event => app.setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); app.submitPrompt() } }} />
      <div className="composer-toolbar"><div className="composer-tools">
        <div className="attach-menu" ref={attachRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setAttachOpen(false) }} onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); setAttachOpen(false); attachRef.current?.querySelector<HTMLButtonElement>('.icon-button')?.focus() }
          if (attachOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...(attachRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
        }}><button className="icon-button" aria-label="Add context" title="Add context" aria-haspopup="menu" aria-expanded={attachOpen} onClick={() => setAttachOpen(!attachOpen)}><Plus size={18} /></button>
          {attachOpen && <div className="attach-popover" role="menu" aria-label="Add context"><span className="popover-label">Add context</span><button role="menuitem" onClick={() => { setAttachOpen(false); void app.pickAttachments() }}><Paperclip size={16} /><span>Attach files<small>Images, documents and code</small></span></button><button role="menuitem" disabled={running} onClick={() => { setAttachOpen(false); void app.openProject() }}><FolderOpen size={16} /><span>Open project<small>Use a local folder as context</small></span></button></div>}
        </div>
        <SelectMenu label="Mode" value={app.mode} options={[{ value: 'AGENT', label: 'Agent' }, { value: 'LOCAL', label: 'Local AI' }, { value: 'MULTI', label: 'Multi-AI' }, { value: 'ASK', label: 'Ask' }]} disabled={running} onChange={value => { app.setMode(value === 'MULTI' ? 'MULTI' : value === 'LOCAL' ? 'LOCAL' : value === 'ASK' ? 'ASK' : 'AGENT'); if (value !== 'AGENT' && app.modelSelection === 'CODEX') app.setModelSelection('AUTO'); if (value === 'LOCAL') app.setModelSelection('AUTO') }} />
        <span className="permission-label" title={app.mode === 'LOCAL' ? 'Private local model with project tools; prompts stay on this computer' : app.mode === 'AGENT' ? 'Can edit files and run commands in the selected workspace' : 'Read-only answers using project context'}><ShieldCheck size={12} />{app.mode === 'LOCAL' ? 'Private · offline' : app.mode === 'MULTI' ? 'Isolated workers' : app.mode === 'AGENT' ? 'Workspace' : 'Read only'}</span>
      </div><div className="composer-actions">
        <SelectMenu label="Model" value={app.modelSelection} options={app.mode === 'LOCAL' ? app.localModelOptions : app.mode === 'MULTI' ? app.multiModelOptions : app.mode === 'AGENT' ? app.agentModelOptions : app.askModelOptions} disabled={running} searchable onChange={app.setModelSelection} footer={<><span>{app.mode === 'LOCAL' ? (app.localModels.length ? 'Ollama · local only' : 'Local model required') : app.providerStatus.connected ? app.providerStatus.displayName : app.codexAvailable ? 'Codex runtime available' : 'No provider connected'}</span><button onClick={() => app.setConnectOpen(true)}>{app.mode === 'LOCAL' ? 'Set up Local AI' : 'Connect provider'}</button></>} />
        {running && app.mode === 'MULTI' && !!app.prompt.trim() && <button className="text-button" onClick={app.submitPrompt}>Send change</button>}{running ? <button className="send-button" aria-label="Stop response" title="Stop response" onClick={app.cancelResponse}><Square size={13} fill="currentColor" /></button> : <button className="send-button" aria-label="Send message" title="Send message" disabled={!app.prompt.trim() && !app.attachments.length} onClick={app.submitPrompt}><ArrowUp size={18} /></button>}
      </div></div>
    </div>
  </section><div className="composer-hint">Enter to send <span>·</span> Shift + Enter for a new line</div></div>
}



