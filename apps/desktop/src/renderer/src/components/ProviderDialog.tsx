import { useState } from 'react'
import { AlertCircle, CheckCircle2, Circle, ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, X } from 'lucide-react'
import { providerDefinitions, type ProviderDefinition, type ProviderLinkKind, type ProviderSection } from '../../../shared/provider-registry'
import { nvidiaCodingModels } from '../../../shared/model-router'
import type { AltrexController } from '../useAltrex'
import { Dialog, IconButton } from './primitives'
import { requestPolicy } from '../../../shared/request-policy'
import { recommendedLocalCodingModel, recommendedLocalVisionModel } from '../../../shared/local-ai'

const sections: Array<{ id: ProviderSection; title: string }> = [
  { id: 'recommended', title: 'Recommended' },
  { id: 'local', title: 'Local' },
  { id: 'additional', title: 'Additional / fallback' },
  { id: 'advanced', title: 'Advanced' },
]

function statusLabel(state: string): string {
  return ({ NOT_CONFIGURED: 'Not configured', TESTING: 'Testing', CONNECTED: 'Connected', RATE_LIMITED: 'Rate limited', QUOTA_EXHAUSTED: 'Quota exhausted', AUTHENTICATION_FAILED: 'Authentication failed', MODEL_UNAVAILABLE: 'Model unavailable', TEMPORARILY_UNAVAILABLE: 'Temporarily unavailable', ERROR: 'Needs testing' } as Record<string, string>)[state] ?? 'Not configured'
}

function StatusIcon({ state }: { state: string }) {
  if (state === 'CONNECTED') return <CheckCircle2 size={14} />
  if (state === 'NOT_CONFIGURED') return <Circle size={13} />
  return <AlertCircle size={14} />
}

export function ProviderDialog({ app }: { app: AltrexController }) {
  const [showSecret, setShowSecret] = useState(false)
  const selected = providerDefinitions.find(provider => provider.id === app.providerDraft.providerId)!
  const busy = app.testingProvider || app.connectingProvider
  const external = (provider: ProviderDefinition, kind: ProviderLinkKind, label: string) => <button type="button" className="provider-link" onClick={() => void app.openProviderLink(provider.id, kind)}>{label}<ExternalLink size={12} /></button>

  return <Dialog title="AI Providers" onClose={() => app.setConnectOpen(false)} className="connect-dialog provider-manager">
    <div className="dialog-head"><div><span className="eyebrow">ALTREX PROVIDER MANAGER</span><h2 id="connect-title">AI Providers</h2></div><IconButton label="Close AI Providers" onClick={() => app.setConnectOpen(false)}><X size={17} /></IconButton></div>
    <p className="connect-intro">Connect a provider with a tiny real validation request. Only verified, healthy connections become available to AUTO and Multi-AI.</p>
    <div className="provider-catalog">
      {sections.map(section => <section className="provider-section" key={section.id} aria-labelledby={`provider-section-${section.id}`}>
        <h3 id={`provider-section-${section.id}`}>{section.title}</h3>
        {providerDefinitions.filter(provider => provider.section === section.id).map(provider => {
          const profile = app.providerStatus.profiles?.find(item => item.providerId === provider.id)
          const state = profile?.connectionState ?? 'NOT_CONFIGURED'
          const active = selected.id === provider.id
          const recommendedInstalled = provider.id === 'ollama' && app.localModels.includes(recommendedLocalCodingModel.id)
          const visionInstalled = provider.id === 'ollama' && app.localModels.includes(recommendedLocalVisionModel.id)
          return <article className={`provider-card${active ? ' selected' : ''}`} key={provider.id}>
            <div className="provider-card-head">
              <span className="provider-mark" aria-hidden="true">{provider.logo}</span>
              <div className="provider-summary"><strong>{provider.name}</strong><p>{provider.description}</p></div>
              <span className={`provider-status status-${state.toLowerCase()}`}><StatusIcon state={state} />{statusLabel(state)}</span>
            </div>
            <div className="provider-card-meta">
              {profile ? <span>{profile.modelsDiscovered} models · {profile.toolCompatibleModels} tool verified{profile.keySuffix ? ` · key ••••${profile.keySuffix}` : ''}</span> : <span>{provider.supportsLocal ? 'No API key required' : 'Credential stored with OS encryption'}</span>}
              <div className="provider-card-actions">
                {provider.apiKeyUrl && external(provider, 'apiKey', provider.id === 'cloudflare' ? 'Get API Token' : 'Get API Key')}
                {provider.installUrl && external(provider, 'install', 'Install Ollama')}
                <button type="button" className="provider-link" onClick={() => { app.selectProvider(provider.id); setShowSecret(false) }}>{active ? 'Selected' : 'Configure'}</button>
              </div>
            </div>
            {profile && profile.connectionState !== 'CONNECTED' && profile.statusMessage && <p className="provider-status-message" role="status">{profile.statusMessage}</p>}
            {active && <div className="provider-config">
              {provider.id === 'cloudflare' && <p className="provider-helper">Workers AI requires your Cloudflare Account ID and an API Token with Workers AI permissions.</p>}
              {provider.id === 'ollama' && <div className="local-model-recommendation">
                <div><span className="eyebrow">BEST FIT FOR YOUR PC</span><strong>{recommendedLocalCodingModel.name}</strong><p>{recommendedLocalCodingModel.description}</p></div>
                <div className="local-model-specs"><span>{recommendedLocalCodingModel.downloadSize}</span><span>{recommendedLocalCodingModel.contextWindow} context</span><span>{recommendedLocalCodingModel.license}</span></div>
                <p className="local-hardware-fit">{recommendedLocalCodingModel.hardwareFit}. Your RX 580 may use CPU fallback because it is outside Ollama's official Windows ROCm support list.</p>
                <button type="button" className="primary-button" disabled={busy || app.installingLocalModel || recommendedInstalled} onClick={() => void app.installLocalModel()}>{app.installingLocalModel ? 'Installing 4.7 GB model…' : recommendedInstalled ? 'Installed and ready' : 'Install recommended model'}</button>
                <div className="local-vision-option"><strong>{recommendedLocalVisionModel.name} · Image understanding</strong><p>Lets ALTREX inspect screenshots, error messages, mockups, documents, charts, and photos locally.</p><div className="local-model-specs"><span>{recommendedLocalVisionModel.downloadSize}</span><span>Text + Image</span><span>{recommendedLocalVisionModel.license}</span></div><button type="button" className="secondary-button" disabled={busy || app.installingLocalModel || visionInstalled} onClick={() => void app.installLocalModel(recommendedLocalVisionModel.id)}>{app.installingLocalModel ? 'Installing local model…' : visionInstalled ? 'Local Vision installed' : 'Install Local Vision'}</button></div>
              </div>}
              {provider.requiredFields.map(field => <label key={field.id}>
                <span>{field.label}</span>
                <div className={field.secret ? 'secret-input' : undefined}>
                  <input aria-label={field.label} type={field.secret && !showSecret ? 'password' : 'text'} value={field.id === 'apiKey' ? app.providerDraft.apiKey : app.providerDraft.additionalFields?.[field.id] ?? ''} autoComplete="off" spellCheck={false} placeholder={field.id === 'apiKey' && profile?.keySuffix ? `Saved credential ending ${profile.keySuffix}` : field.placeholder} onChange={event => field.id === 'apiKey' ? app.setProviderDraft(current => ({ ...current, apiKey: event.target.value })) : app.setProviderDraft(current => ({ ...current, additionalFields: { ...current.additionalFields, [field.id]: event.target.value } }))} />
                  {field.secret && <IconButton label={showSecret ? 'Hide credential' : 'Show credential'} onClick={() => setShowSecret(value => !value)}>{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton>}
                </div>
                {field.helper && <small>{field.helper}</small>}
              </label>)}
              {provider.id === 'cloudflare' && external(provider, 'accountId', 'How to Find Account ID')}
              <label><span>{provider.id === 'ollama' ? 'Local model' : 'Default model'}</span><input list="provider-model-suggestions" value={app.providerDraft.model} placeholder={provider.id === 'ollama' ? 'Detected automatically, or enter an installed model' : 'Provider model ID'} onChange={event => app.setProviderDraft(current => ({ ...current, model: event.target.value }))} /><datalist id="provider-model-suggestions">{[...new Set([...app.providerModels, ...(provider.id === 'nvidia' ? nvidiaCodingModels.map(model => model.id) : [])])].map(model => <option value={model} key={model} />)}</datalist></label>
              {provider.id === 'custom' && <label><span>API endpoint</span><input value={app.providerDraft.baseUrl} spellCheck={false} onChange={event => app.setProviderDraft(current => ({ ...current, baseUrl: event.target.value }))} /></label>}
              {!!app.providerModels.length && <details className="provider-model-list"><summary>View discovered models · {app.providerModels.length}</summary><div>{app.providerModels.slice(0, 80).map(model => <button type="button" key={model} onClick={() => app.setProviderDraft(current => ({ ...current, model }))}>{model}</button>)}</div></details>}
              <div className="provider-config-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void app.testProvider()}>{app.testingProvider ? (provider.id === 'ollama' ? 'Detecting...' : 'Testing...') : (provider.id === 'ollama' ? 'Detect Ollama' : 'Test connection')}</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void app.refreshProviderModels()}><RefreshCw size={13} />Refresh Models</button>
                {profile && <button type="button" className="text-button danger" disabled={busy} onClick={() => void app.disconnectProvider(provider.id)}>Disconnect</button>}
                <button type="button" className="primary-button" disabled={busy} onClick={() => void app.connectProvider()}>{app.connectingProvider ? 'Saving & testing...' : provider.id === 'ollama' ? 'Detect & Save' : 'Save & Test'}</button>
              </div>
              <details className="provider-policy"><summary>Request budgets and timeouts</summary><p>Safe request limits for this connection.</p><div className="provider-form">{([{ key: 'inputTokens', label: 'Input token budget', scale: 1 }, { key: 'outputTokens', label: 'Output token budget', scale: 1 }, { key: 'connectionMs', label: 'Connection timeout (seconds)', scale: 1000 }, { key: 'firstTokenMs', label: 'First token timeout (seconds)', scale: 1000 }, { key: 'idleMs', label: 'Stream idle timeout (seconds)', scale: 1000 }, { key: 'overallMs', label: 'Overall timeout (seconds)', scale: 1000 }, { key: 'maxAttempts', label: 'Maximum attempts', scale: 1 }, { key: 'concurrency', label: 'Concurrent requests', scale: 1 }] as const).map(({ key, label, scale }) => <label key={key}><span>{label}</span><input type="number" min={1} value={(app.providerDraft.requestPolicy?.[key] ?? requestPolicy(app.providerDraft.providerId)[key]) / scale} onChange={event => app.setProviderDraft(current => ({ ...current, requestPolicy: { ...current.requestPolicy, [key]: Number(event.target.value) * scale } }))} /></label>)}</div></details>
            </div>}
          </article>
        })}
      </section>)}
    </div>
    <p className="credential-note"><KeyRound size={13} />Credentials are encrypted with your operating system and never sent to projects, worker prompts, activity logs, or diagnostics.</p>
    {app.connectionResult !== null && <p className="connection-result" role="status">{app.connectionResult}</p>}
  </Dialog>
}
