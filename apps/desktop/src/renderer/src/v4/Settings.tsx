import { useEffect, useRef, useState } from "react";
import { X, Shield, Server, SlidersHorizontal } from "lucide-react";
import type { CommandResponse, RoutingMode } from "@altrex/contracts";
import { Dialog } from "../components/primitives";
import { healthLabel, label } from "./state";
import { Status } from "./TaskCard";
import { CraxConnect } from "./CraxConnect";
import { ProviderLogo, RouteLabel } from "./logos";
import type { Workspace } from "./useWorkspace";

// These identifiers are the existing host presets; URLs/model defaults stay in the host.
const presets = [
  { id: "crax-gpt", name: "crax-gpt" },
  { id: "google", name: "Google Gemini" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "groq", name: "Groq" },
  { id: "ollama", name: "Local AI (Ollama)" },
  { id: "openai", name: "OpenAI" },
  { id: "cerebras", name: "Cerebras" },
  { id: "sambanova", name: "SambaNova" },
  { id: "cloudflare", name: "Cloudflare Workers AI" },
  { id: "nim-local", name: "Self-hosted NVIDIA NIM" },
  { id: "custom", name: "Custom endpoint" },
];
export function Settings({
  app,
  onClose,
  routingMode,
  initialProvider,
  customModel,
  setCustomModel,
}: {
  app: Workspace;
  onClose: () => void;
  routingMode: RoutingMode;
  /** Provider whose connection form opens first (from the setup prompt). */
  initialProvider?: string | undefined;
  customModel: string;
  setCustomModel: (model: string) => void;
}) {
  const [section, setSection] = useState("Providers"),
    [selected, setSelected] = useState(initialProvider ?? (routingMode === "LOCAL_ONLY" ? "ollama" : "google")),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false);
  const [baseUrl, setBaseUrl] = useState(""),
    [model, setModel] = useState(""),
    [account, setAccount] = useState(""),
    [models, setModels] = useState<CommandResponse<"model.list">>(),
    [route, setRoute] = useState<CommandResponse<"router.preview">>(),
    [profile, setProfile] = useState<CommandResponse<"project.permissions">>();
  const [tools, setTools] = useState<CommandResponse<"tool.list">>(),
    [query, setQuery] = useState(""),
    [notice, setNotice] = useState("");
  const keyInput = useRef<HTMLInputElement>(null),
    localPreset = selected === "ollama" || selected === "nim-local";
  useEffect(() => {
    if (app.project)
      void app
        .invoke("project.permissions", { projectPath: app.project.path })
        .then(setProfile);
  }, [app.project?.path, app.invoke]);
  const connect = async () => {
    setBusy(true);
    setNotice("");
    const apiKey = keyInput.current?.value ?? "";
    if (keyInput.current) keyInput.current.value = "";
    const result = await app.invoke("provider.connect", {
      providerId: selected,
      apiKey,
      baseUrl,
      model,
      ...(selected === "cloudflare"
        ? { additionalFields: { accountId: account } }
        : {}),
    });
    if (result) {
      app.setProviders(result);
      const provider = result.find((p) => p.providerId === selected);
      // The consent checkbox is required to save; record it in the backend, which enforces it.
      if (provider && provider.privacy === "cloud")
        await app.invoke("consent.grant", {
          providerId: provider.providerId,
          baseUrl: provider.baseUrl,
        });
      const consents = await app.invoke("consent.list", {});
      if (consents) app.setConsents(consents);
      setNotice(
        provider
          ? `${provider.displayName}: ${healthLabel[provider.health] ?? provider.health}`
          : "Provider configuration saved.",
      );
    }
    setBusy(false);
  };
  const updateProviders = async () => {
    setBusy(true);
    const result = await app.invoke("provider.test", {});
    if (result) app.setProviders(result);
    setBusy(false);
  };
  return (
    <Dialog
      title="Settings"
      onClose={onClose}
      className="v4-dialog v4-settings"
    >
      <header>
        <h2>Settings</h2>
        <button className="quiet" aria-label="Close settings" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="v4-settings-layout">
        <nav aria-label="Settings sections">
          {["Providers", "AI & models", "Permissions", "General"].map(
            (name) => (
              <button
                key={name}
                aria-current={section === name ? "page" : undefined}
                onClick={() => setSection(name)}
              >
                {name === "Providers" ? (
                  <Server size={16} />
                ) : name === "Permissions" ? (
                  <Shield size={16} />
                ) : (
                  <SlidersHorizontal size={16} />
                )}
                {name}
              </button>
            ),
          )}
        </nav>
        <div className="v4-settings-body">
          {section === "Providers" && (
            <>
              <h3>AI providers</h3>
              <p className="muted">
                Measured connections. Automatic routing can use any connected
                provider. Remote endpoints may receive your prompt and relevant
                project content.
              </p>
              <button
                disabled={busy || !app.providers.length}
                onClick={() => void updateProviders()}
              >
                {busy ? "Connecting / checking…" : "Check provider health"}
              </button>
              <small className="block muted">
                Health checks make a small request to each configured provider.
              </small>
              <div className="v4-provider-list">
                {presets.map((preset) => {
                  const provider = app.providers.find(
                    (p) => p.providerId === preset.id,
                  );
                  return (
                    <article key={preset.id}>
                      <div className="v4-row">
                        <div className="v4-provider-name">
                          <ProviderLogo providerId={preset.id} size={18} />
                          <div>
                            <strong>{preset.name}</strong>
                            <small
                              className={
                                provider?.health === "HEALTHY" ? "good" : "muted"
                              }
                            >
                              {provider ? (provider.health === "HEALTHY" ? "● " : "○ ") : "○ "}
                              {provider
                                ? healthLabel[provider.health]
                                : "Not configured"}
                              {provider ? ` · ${provider.privacy === "local" ? "Local" : "Cloud"}` : ""}
                              {provider && provider.modelsDiscovered
                                ? ` · ${provider.modelsDiscovered} models`
                                : ""}
                            </small>
                          </div>
                        </div>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setSelected(preset.id);
                            setBaseUrl("");
                            setModel("");
                            setConsent(false);
                            setNotice("");
                            if (keyInput.current) keyInput.current.value = "";
                            document
                              .getElementById("v4-connect-heading")
                              ?.scrollIntoView({ block: "nearest" });
                          }}
                        >
                          Configure
                        </button>
                      </div>
                      {provider && (
                        <details>
                          <summary>Connection details</summary>
                          <p>{provider.statusMessage}</p>
                          <p className="mono">{provider.baseUrl}</p>
                          <p>
                            {provider.protocol} · {provider.modelsDiscovered}{" "}
                            discovered models
                          </p>
                          <p>
                            Last check:{" "}
                            {provider.lastCheckedAt
                              ? new Date(
                                  provider.lastCheckedAt,
                                ).toLocaleString()
                              : "Not checked"}
                          </p>
                          <p>
                            Credentials:{" "}
                            {provider.hasCredential
                              ? "Stored securely"
                              : "Not stored"}
                            {provider.lastErrorCategory
                              ? ` · ${label(provider.lastErrorCategory)}`
                              : ""}
                          </p>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setBusy(true);
                              void app
                                .invoke("provider.disconnect", {
                                  providerId: provider.providerId,
                                })
                                .then((result) => {
                                  if (result) app.setProviders(result);
                                  setBusy(false);
                                });
                            }}
                          >
                            Disconnect
                          </button>
                        </details>
                      )}
                    </article>
                  );
                })}
              </div>
              {selected === "crax-gpt" ? (
                <CraxConnect
                  app={app}
                  onViewModels={(list) => {
                    setModels(list);
                    setQuery("");
                    setSection("AI & models");
                  }}
                />
              ) : (
              <form
                className="v4-connect"
                onSubmit={(e) => {
                  e.preventDefault();
                  void connect();
                }}
              >
                <h3 id="v4-connect-heading">
                  Connect {presets.find((p) => p.id === selected)?.name}
                </h3>
                <button
                  type="button"
                  className="v4-link"
                  onClick={() => {
                    const kind =
                      selected === "ollama"
                        ? "install"
                        : ["custom", "nim-local"].includes(selected)
                          ? "docs"
                          : "apiKey";
                    void app
                      .invoke("provider.openLink", { providerId: selected, kind })
                      .then((result) =>
                        setNotice(
                          result?.opened
                            ? "Opened the official page in your browser."
                            : "This page could not be opened from here.",
                        ),
                      );
                  }}
                >
                  {selected === "ollama"
                    ? "Download Ollama ↗"
                    : ["custom", "nim-local"].includes(selected)
                      ? "Setup guide ↗"
                      : "Get an API key ↗"}
                </button>
                {!localPreset && (
                  <label>
                    API key
                    <input
                      ref={keyInput}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="API key"
                    />
                  </label>
                )}
                {selected === "cloudflare" && (
                  <label>
                    Account ID
                    <input
                      value={account}
                      onChange={(e) => setAccount(e.target.value)}
                    />
                  </label>
                )}
                <small className="muted">
                  Keys are sent once to encrypted desktop storage and cleared
                  from this form. Existing keys are never displayed.
                </small>
                {["custom", "nim-local"].includes(selected) ? (
                  <label>
                    Endpoint URL
                    <input
                      required
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://your-server/v1"
                    />
                  </label>
                ) : null}
                <details>
                  <summary>Advanced configuration</summary>
                  {/* Only custom and self-hosted endpoints accept a URL; the host ignores it for fixed presets. */}
                  <label>
                    Model (optional)
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="Discover available models"
                    />
                  </label>
                </details>
                <label className="v4-checkbox">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I allow this endpoint to receive my prompts and selected
                  project content. A remote or tunneled endpoint sends data off
                  this computer.
                </label>
                {localPreset && (
                  <p className="muted">
                    Start your local server and install a model first. ALTREX
                    can connect to it; server installation and startup are not
                    exposed by contract v1.
                  </p>
                )}
                <button className="primary" disabled={busy || !consent}>
                  {busy ? "Connecting…" : "Save connection"}
                </button>
                {notice && <p role="status">{notice}</p>}
              </form>
              )}
            </>
          )}
          {section === "AI & models" && (
            <>
              <h3>Routing & models</h3>
              <p>
                Auto chooses an eligible model. Fast, Powerful, Free only, and
                Local only constrain routing. Unknown pricing or capabilities
                remain unknown.
              </p>
              <div className="v4-actions">
                <button
                  onClick={() =>
                    void app.invoke("model.list", {}).then(setModels)
                  }
                >
                  Load models
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void app.invoke("provider.refresh", {}).then((result) => {
                      setModels(result);
                      setBusy(false);
                    });
                  }}
                >
                  Discover models
                </button>
                <button
                  onClick={() =>
                    void app
                      .invoke("router.preview", {
                        mode: routingMode,
                        tools: true,
                      })
                      .then(setRoute)
                  }
                >
                  Explain current routing
                </button>
              </div>
              {route && (
                <div className="v4-notice">
                  <p>
                    {route.primary ? (
                      <RouteLabel providerId={route.primary.providerId} model={route.primary.model} />
                    ) : (
                      "No eligible endpoint"
                    )}
                  </p>
                  {route.reasons.map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                  <details>
                    <summary>Fallbacks & excluded candidates</summary>
                    {route.fallbacks.map((candidate, i) => (
                      <p key={i}>
                        <RouteLabel providerId={candidate.providerId} model={candidate.model} />
                      </p>
                    ))}
                    {route.rejected.map((candidate, i) => (
                      <p key={i}>
                        <RouteLabel providerId={candidate.providerId} model={candidate.model} />:{" "}
                        {candidate.detail}
                      </p>
                    ))}
                  </details>
                </div>
              )}
              <label>
                Custom model selection
                <input
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="Choose a discovered model below"
                />
              </label>
              <input
                aria-label="Filter models"
                placeholder="Filter models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {models
                ?.filter((m) =>
                  `${m.displayName} ${m.model}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .slice(0, 100)
                .map((m) => (
                  <details key={`${m.providerId}-${m.baseUrl}-${m.model}`}>
                    <summary>
                      <ProviderLogo providerId={m.providerId} model={m.model} />{" "}
                      {m.displayName || m.model} · {m.providerId === "crax-gpt" ? "crax-gpt" : m.providerId}
                    </summary>
                    <p>
                      {m.health} · Available:{" "}
                      {m.available === null
                        ? "Unknown"
                        : m.available
                          ? "Yes"
                          : "No"}{" "}
                      · Free:{" "}
                      {m.free === null ? "Unknown" : m.free ? "Yes" : "No"}
                    </p>
                    {Object.entries(m.capabilities).map(([name, value]) => (
                      <p key={name}>
                        {name}: {value === null ? "Unknown" : String(value)}
                      </p>
                    ))}
                    <button onClick={() => setCustomModel(m.model)}>
                      Use in Custom mode
                    </button>
                  </details>
                ))}
              {models && (
                <small>
                  Showing up to 100 matching models. Narrow the filter for more.
                </small>
              )}
            </>
          )}
          {section === "Permissions" && (
            <>
              <h3>Project permissions</h3>
              {app.project && profile ? (
                <>
                  <p>{app.project.name}</p>
                  <label>
                    Permission profile
                    <select
                      value={profile.profile}
                      onChange={(e) => {
                        const next = e.target.value as
                          | "read_only"
                          | "standard"
                          | "autonomous";
                        void app
                          .invoke("project.permissions", {
                            projectPath: app.project!.path,
                            profile: next,
                          })
                          .then(setProfile);
                      }}
                    >
                      <option value="read_only">Read-only</option>
                      <option value="standard">Standard</option>
                      <option value="autonomous">Autonomous</option>
                    </select>
                  </label>
                  <p>
                    Read-only allows low-risk inspection. Standard allows
                    ordinary edits and commands, and asks for high-risk actions.
                    Autonomous allows high-risk actions without individual
                    approval. Forbidden actions remain blocked in every profile.
                  </p>
                  {profile.profile === "autonomous" && (
                    <p className="v4-warning">
                      Autonomous mode allows high-risk commands with your
                      operating system permissions.
                    </p>
                  )}
                </>
              ) : (
                <p>Open a project to choose its permission profile.</p>
              )}
              <button
                onClick={() => void app.invoke("tool.list", {}).then(setTools)}
              >
                Inspect available tools
              </button>
              {tools?.map((tool) => (
                <div className="v4-row" key={tool.name}>
                  <div>
                    <strong>{tool.name}</strong>
                    <p>{tool.description}</p>
                  </div>
                  <Status value={tool.risk} />
                </div>
              ))}
            </>
          )}
          {section === "General" && (
            <>
              <h3>ALTREX CODE V4</h3>
              <p>
                A focused coding workspace with evidence-based verification.
              </p>
              <p>
                Dark appearance · Bundled Inter and JetBrains Mono · System
                reduced-motion preference respected.
              </p>
              <h4>Keyboard shortcuts</h4>
              <p>
                Ctrl/Cmd + K: commands
                <br />
                Ctrl/Cmd + Enter: run task
                <br />
                Ctrl/Cmd + N: new session
                <br />
                Escape: close dialogs
              </p>
              <h4>Recovery & privacy</h4>
              <p>
                Task history is stored by the desktop core. Interrupted tasks
                are never resumed automatically. The renderer stores only
                interface preferences and cloud-consent acknowledgments.
              </p>
              <p>Core contract: {app.core?.contractVersion ?? "Unavailable"}</p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
