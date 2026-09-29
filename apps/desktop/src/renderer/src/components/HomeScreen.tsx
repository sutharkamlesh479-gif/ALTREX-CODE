import { Code2, Search, ScanLine, Wrench } from 'lucide-react'
import { AltrexCodeSymbol } from '../AltrexBrand'

const suggestions = [
  { title: 'Explore', description: 'Understand your codebase', icon: Search, prompt: 'Explore this project and explain its architecture, entry points, and how the main pieces fit together.' },
  { title: 'Build', description: 'Create something useful', icon: Code2, prompt: 'Help me build a new feature in this project. First inspect the codebase. The feature I want is: ' },
  { title: 'Review', description: 'Find room to improve', icon: ScanLine, prompt: 'Review the current changes for bugs, security issues, and regressions. Explain your findings with file references.' },
  { title: 'Fix', description: 'Get things working again', icon: Wrench, prompt: 'Investigate and fix this issue in the project. Find the root cause and verify the correction. The issue is: ' },
]
export function HomeScreen({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <section className="home-screen" aria-labelledby="home-title"><div className="home-content"><AltrexCodeSymbol size={44} /><h1 id="home-title">What should we build?</h1><p className="home-subtitle">A little context. A clear idea. Your next step.</p><div className="suggestion-cards">{suggestions.map(({ title, description, icon: Icon, prompt }) => <button key={title} onClick={() => onPrompt(prompt)}><Icon size={18} /><strong>{title}</strong><span>{description}</span></button>)}</div></div></section>
}
