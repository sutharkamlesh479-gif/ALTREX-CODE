import { Blocks, Bot, Braces, ShieldCheck } from 'lucide-react'

export type Mode = 'ASK' | 'PLAN' | 'AGENT' | 'LOCAL' | 'SWARM' | 'MULTI'

export const defaultMode: Mode = 'AGENT'

export const commandItems = [
  { label: 'New chat', detail: 'Start a conversation; keep your history', icon: Bot, action: 'new-task' },
  { label: 'Open project', detail: 'Choose a local repository', icon: Braces, action: 'open-project' },
  { label: 'Connect AI provider', detail: 'Configure a model connection', icon: Blocks, action: 'models' },
  { label: 'Settings', detail: 'Providers, appearance and permissions', icon: ShieldCheck, action: 'security' },
] as const
