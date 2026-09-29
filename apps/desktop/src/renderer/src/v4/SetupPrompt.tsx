import { useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { Dialog } from "../components/primitives";
import type { Invoke } from "./useWorkspace";
import { ProviderLogo } from "./logos";

/** Providers suggested for a first setup. Links are opened by the desktop host from its own registry. */
export const setupProviders = [
  { id: "crax-gpt", name: "crax-gpt", note: "Free OpenAI-compatible AI gateway. One key, many live models.", link: "apiKey", linkLabel: "Open crax-gpt" },
  { id: "google", name: "Google Gemini", note: "Recommended main provider. Strong general coding.", link: "apiKey", linkLabel: "Get API key" },
  { id: "nvidia", name: "NVIDIA NIM", note: "Recommended main provider. Large coding models.", link: "apiKey", linkLabel: "Get API key" },
  { id: "openrouter", name: "OpenRouter", note: "Many models with one key; free models for Free only mode.", link: "apiKey", linkLabel: "Get API key" },
  { id: "groq", name: "Groq", note: "Very fast responses for Fast mode.", link: "apiKey", linkLabel: "Get API key" },
  { id: "ollama", name: "Local AI (Ollama)", note: "Runs on this computer. No API key; install Ollama and a model.", link: "install", linkLabel: "Download Ollama" },
] as const;

export function SetupPrompt({
  invoke,
  codexAvailable = false,
  onUseCodex,
  onAdd,
  onClose,
}: {
  invoke: Invoke;
  /** The OpenAI Codex CLI is installed (it signs in with the user's ChatGPT account, no API key). */
  codexAvailable?: boolean;
  onUseCodex?: () => void;
  /** Open provider settings with this provider's connection form. */
  onAdd: (providerId: string) => void;
  onClose: () => void;
}) {
  const [notice, setNotice] = useState("");
  const open = async (providerId: string, kind: "apiKey" | "install", name: string) => {
    const result = await invoke("provider.openLink", { providerId, kind });
    setNotice(
      result?.opened
        ? `${name} opened in your browser. Create a key there, then choose “Add key”.`
        : `The ${name} page could not be opened from here. Open provider settings for details.`,
    );
  };
  return (
    <Dialog title="Add a main AI provider" onClose={onClose} className="v4-dialog v4-setup">
      <header>
        <KeyRound size={20} />
        <h2>Add a main AI provider</h2>
      </header>
      <p>
        ALTREX needs at least one AI provider before it can work on your
        project. Add one main API key (Google Gemini or NVIDIA recommended), or
        use local AI with Ollama.
      </p>
      <p className="muted">
        1. Get a key from the provider’s official page. 2. Choose “Add key” and
        paste it. Keys are stored encrypted on this computer and never shown
        again.
      </p>
      <div className="v4-setup-list">
        {codexAvailable && onUseCodex && (
          <article>
            <div>
              <strong><ProviderLogo providerId="codex" /> ChatGPT Codex</strong>
              <small className="muted">
                Codex CLI detected on this computer. Uses your ChatGPT
                subscription for Build tasks; no API key needed.
              </small>
            </div>
            <div className="v4-setup-actions">
              <button className="primary" onClick={onUseCodex}>
                Use ChatGPT Codex
              </button>
            </div>
          </article>
        )}
        {setupProviders.map((provider) => (
          <article key={provider.id}>
            <div className="v4-provider-name">
              <ProviderLogo providerId={provider.id} size={18} />
              <div>
              <strong>{provider.name}</strong>
              <small className="muted">{provider.note}</small>
              </div>
            </div>
            <div className="v4-setup-actions">
              <button
                onClick={() => void open(provider.id, provider.link, provider.name)}
              >
                {provider.linkLabel}
                <ExternalLink size={13} />
              </button>
              <button className="primary" onClick={() => onAdd(provider.id)}>
                {provider.id === "ollama" ? "Connect" : "Add key"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {notice && <p role="status">{notice}</p>}
      <footer>
        <button onClick={onClose}>Later</button>
        <button onClick={() => onAdd("google")}>Open provider settings</button>
      </footer>
    </Dialog>
  );
}
