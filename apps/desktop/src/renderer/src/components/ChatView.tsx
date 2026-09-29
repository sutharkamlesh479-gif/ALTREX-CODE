import { useEffect, useState } from 'react'
import { ChevronDown, FileCode2, LoaderCircle, TerminalSquare, AlertCircle, Check, ArrowDown, X } from 'lucide-react'
import type { LocalConversationMessage } from '../local-conversation'
import type { AltrexController } from '../useAltrex'
import { AltrexCodeSymbol } from '../AltrexBrand'
import { CopyButton, MessageContent } from './MessageContent'
import { IconButton } from './primitives'
import { MultiAiRun } from './MultiAiRun'

function WorkingTime({ message }: { message: LocalConversationMessage }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (message.status !== 'streaming') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [message.status])
  const end = message.finishedAt ? Date.parse(message.finishedAt) : now
  const seconds = Math.max(0, Math.floor((end - Date.parse(message.createdAt)) / 1000))
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return <span>{message.status === 'streaming' ? `Working for ${duration}` : message.status === 'cancelled' ? 'Stopped' : message.status === 'error' ? 'Task interrupted' : message.finishedAt ? `Worked for ${duration}` : 'Response'}</span>
}

export function AgentActivity({ message }: { message: LocalConversationMessage }) {
  return <div className="agent-activity">
    {(message.activities?.length ?? 0) > 0 && <details><summary><ChevronDown size={13} /><span>Activity</span><small>{message.activities!.length} updates</small></summary><div className="activity-log">{message.activities!.map((activity, index) => <p key={index}>{activity}</p>)}</div></details>}
    {message.commands?.map((result, index) => <details key={index}><summary><TerminalSquare size={14} /><span>Ran command <code>{result.command}</code></span>{result.exitCode === 0 ? <Check className="success" size={13} /> : <span className="danger">{result.exitCode === null ? 'No exit code' : `Exit ${result.exitCode}`}</span>}<ChevronDown size={13} /></summary><pre className="command-output">{result.output || 'Command produced no output.'}</pre></details>)}
    {!!message.files?.length && <details><summary><FileCode2 size={14} /><span>Changed {message.files.length} {message.files.length === 1 ? 'file' : 'files'}</span><ChevronDown size={13} /></summary><div className="changed-paths">{message.files.map(file => <code key={file}>{file}</code>)}</div></details>}
  </div>
}

export function ChatView({ app }: { app: AltrexController }) {
  const [scrolledUp, setScrolledUp] = useState(false)
  return <section className="conversation-panel conversation-active" aria-label="Current conversation"><div className="message-list" ref={app.messageListRef} onScroll={event => { const node = event.currentTarget; const following = node.scrollHeight - node.scrollTop - node.clientHeight < 100; app.followOutput.current = following; setScrolledUp(!following) }}>
    <div className="conversation-column">{app.messages.map(message => <article key={message.id} className={`message-row message-${message.role}`}>
      {message.role === 'user' ? <div className="user-bubble"><p>{message.content}</p>{!!message.attachments?.length && <div className="message-attachments">{message.attachments.map(file => <div key={file.id}>{file.previewDataUrl && <img src={file.previewDataUrl} alt={file.name} />}<span>{file.name}</span></div>)}</div>}</div> : <div className="assistant-document">
        <div className="response-heading"><AltrexCodeSymbol size={20} /><WorkingTime message={message} />{message.status === 'streaming' && <LoaderCircle size={13} className="spinner" />}</div>
        {message.status === 'streaming' && <p className="live-status" role="status">{message.activity ?? 'Starting your task…'}</p>}
        <AgentActivity message={message} />
        {app.projectRuns.filter(run => run.id === message.id).map(run => <MultiAiRun key={run.id} run={run} onRestart={() => app.restartRun(run)} busy={!!app.activeRequestId} />)}
        {message.status === 'error' ? <div className="error-state" role="alert"><AlertCircle size={17} /><div><strong>{/key|auth/i.test(message.content) ? 'Check your provider connection' : /quota|credit/i.test(message.content) ? 'Provider quota unavailable' : /rate|429/i.test(message.content) ? 'Provider rate limit reached' : /model/i.test(message.content) ? 'Model request failed' : 'Could not complete the task'}</strong><p>{message.content}</p><button onClick={() => app.setConnectOpen(true)}>Provider settings</button><button onClick={() => { app.setPrompt(app.messages.slice(0, app.messages.indexOf(message)).reverse().find(item => item.role === 'user')?.content ?? ''); app.focusComposer() }}>Edit and retry</button></div></div> : <MessageContent content={message.content} />}
        {message.status !== 'streaming' && message.content && <div className="response-footer"><CopyButton text={message.content} /><span title={message.model}>{message.provider}{message.model ? ` · ${message.model}` : ''}</span></div>}
      </div>}
    </article>)}</div>
  </div>{scrolledUp && <button className="jump-latest" onClick={() => { app.followOutput.current = true; app.messageListRef.current?.scrollTo({ top: app.messageListRef.current.scrollHeight }); setScrolledUp(false) }}><ArrowDown size={14} />Latest response</button>}</section>
}

export function OutputPanel({ app, onClose }: { app: AltrexController; onClose: () => void }) {
  const files = [...new Set(app.messages.flatMap(message => message.files ?? []))]
  const commands = app.messages.flatMap(message => message.commands ?? [])
  return <aside className="output-panel" aria-label="Task results"><header><strong>Task results</strong><IconButton label="Close task results" onClick={onClose}><X size={16} /></IconButton></header><div className="output-scroll">{!!files.length && <section><h3>Files changed <span>{files.length}</span></h3>{files.map(file => <div className="output-file" key={file}><FileCode2 size={15} /><code>{file}</code></div>)}</section>}{!!commands.length && <section><h3>Commands <span>{commands.length}</span></h3>{commands.map((command, index) => <details key={index}><summary><TerminalSquare size={14} /><code>{command.command}</code></summary><span className={command.exitCode === 0 ? 'success' : 'danger'}>Exit {command.exitCode ?? 'unknown'}</span><pre className="command-output">{command.output}</pre></details>)}</section>}</div></aside>
}
