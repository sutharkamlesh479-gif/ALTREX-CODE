import {
  siClaude,
  siCloudflare,
  siDeepseek,
  siGooglegemini,
  siMeta,
  siMinimax,
  siMistralai,
  siMoonshotai,
  siNvidia,
  siOllama,
  siOpenrouter,
  siQwen,
  type SimpleIcon,
} from "simple-icons";

// Official brand icons come from simple-icons (CC0, bundled locally; no remote images). Brands without an
// official icon in that set get a neutral letter chip instead of an invented logo. crax-gpt's mark is the
// site's own favicon artwork.

const providerIcons: Record<string, SimpleIcon> = {
  google: siGooglegemini,
  openrouter: siOpenrouter,
  nvidia: siNvidia,
  "nim-local": siNvidia,
  ollama: siOllama,
  cloudflare: siCloudflare,
};

const providerNames: Record<string, string> = {
  google: "Gemini",
  openrouter: "OpenRouter",
  nvidia: "NVIDIA",
  "nim-local": "NVIDIA NIM",
  ollama: "Ollama",
  cloudflare: "Cloudflare",
  groq: "Groq",
  openai: "OpenAI",
  cerebras: "Cerebras",
  sambanova: "SambaNova",
  "crax-gpt": "crax-gpt",
  custom: "Custom endpoint",
  codex: "ChatGPT Codex",
};

/** Model families with their own official icon; other models use their provider's logo. */
const modelFamilies: Array<[RegExp, SimpleIcon]> = [
  [/gemini|gemma/i, siGooglegemini],
  [/claude/i, siClaude],
  [/llama/i, siMeta],
  [/mistral|mixtral|codestral|devstral|magistral/i, siMistralai],
  [/qwen|qwq/i, siQwen],
  [/deepseek/i, siDeepseek],
  [/kimi|moonshot/i, siMoonshotai],
  [/minimax/i, siMinimax],
  [/nemotron/i, siNvidia],
];

export function providerLabel(providerId: string | null | undefined): string {
  if (!providerId) return "System";
  return providerNames[providerId] ?? providerId;
}

function CraxMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="v4-logo-img">
      <rect width="24" height="24" rx="5" fill="#050505" />
      <path d="M18.2 6.2a8.1 8.1 0 1 0 0 11.6" fill="none" stroke="#f2f2f2" strokeWidth="2.5" strokeLinecap="round" />
      <path d="m14.2 7.7 5.6 4.3-5.6 4.3 1.6-4.3z" fill="#3d7dff" />
    </svg>
  );
}

/**
 * A small provider/model logo. The model's family icon is used when it has one; otherwise the provider's.
 * Decorative: the visible label next to it carries the name for assistive technology.
 */
export function ProviderLogo({
  providerId,
  model,
  size = 14,
}: {
  providerId?: string | null | undefined;
  model?: string | null | undefined;
  size?: number;
}) {
  if (providerId === "crax-gpt" && !model) return <CraxMark size={size} />;
  const family = model ? modelFamilies.find(([pattern]) => pattern.test(model))?.[1] : undefined;
  const icon = family ?? (providerId ? providerIcons[providerId] : undefined);
  if (icon)
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="v4-logo-img">
        <path d={icon.path} fill="currentColor" />
      </svg>
    );
  if (providerId === "crax-gpt") return <CraxMark size={size} />;
  const letter = (providerLabel(providerId) || "?").replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return (
    <span className="v4-logo-mono" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}>
      {letter}
    </span>
  );
}

/** Logo + "Provider • model" label. */
export function RouteLabel({ providerId, model, compact = false }: { providerId?: string | null | undefined; model?: string | null | undefined; compact?: boolean }) {
  const shortModel = model ? (compact ? model.split("/").at(-1)! : model) : "";
  return (
    <span className="v4-route-label" title={model ? `${providerLabel(providerId)} • ${model}` : providerLabel(providerId)}>
      <ProviderLogo providerId={providerId} model={model} />
      <span>
        {providerLabel(providerId)}
        {shortModel && <span className="muted"> • {shortModel}</span>}
      </span>
    </span>
  );
}
