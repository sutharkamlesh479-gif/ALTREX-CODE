import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'

export function IconButton({ label, children, onClick, disabled = false, className = '' }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}

export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const target = ref.current
    const focusable = () => [...(target?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length)
    ;(target?.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? target)?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current() }
      if (event.key !== 'Tab') return
      const nodes = focusable(), first = nodes[0], last = nodes.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === target)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${className}`}>{children}</section></div>
}

export type SelectOption = string | { value: string; label: string }
export function SelectMenu({ label, value, options, onChange, footer, disabled = false, searchable = false }: { label: string; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; footer?: ReactNode; disabled?: boolean; searchable?: boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), id = useId()
  const normalized = options.map(option => typeof option === 'string' ? { value: option, label: option } : option)
  const filtered = normalized.filter(option => option.label.toLowerCase().includes(query.toLowerCase()) || option.value.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    root.current?.querySelector<HTMLElement>('input,[role="option"][aria-selected="true"],[role="option"]')?.focus()
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div className={`select-menu ${label === 'Model' ? 'model-menu' : ''}`} ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
      const index = nodes.indexOf(document.activeElement as HTMLElement)
      nodes[event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length]?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="select-trigger" aria-label={label} title={normalized.find(option => option.value === value)?.label ?? value} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { setOpen(!open); setQuery('') }}><span>{normalized.find(option => option.value === value)?.label ?? value}</span><ChevronDown size={13} /></button>
    {open && <div className="select-popover">
      <div className="popover-label">{label === 'Model' ? 'Choose a model' : label}</div>
      {searchable && <label className="menu-search"><Search size={14} /><input aria-label={`Search ${label.toLowerCase()}s`} placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div id={id} role="listbox" aria-label={label} className="select-options">{filtered.map(option => <button type="button" role="option" aria-selected={option.value === value} key={option.value} onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus() }}><span>{option.label}</span>{option.value === value && <Check size={14} />}</button>)}{!filtered.length && <p className="empty-small">No matching models</p>}</div>
      {footer && <div className="popover-footer" onClick={() => setOpen(false)}>{footer}</div>}
    </div>}
  </div>
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return <button type="button" className="toggle" role="switch" aria-label={label} aria-checked={checked} onClick={onChange}><span /></button>
}
