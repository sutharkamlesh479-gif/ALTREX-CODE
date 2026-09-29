import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { CommandResponse, ProviderView } from "@altrex/contracts";
import { healthLabel } from "./state";
import { ProviderLogo } from "./logos";
import type { Workspace } from "./useWorkspace";

type Models = CommandResponse<"model.list">;

/**
 * Guided crax-gpt setup: open the site, paste one key, connect. crax-gpt offers no third-party login
 * handoff, so the key is the only input; the host validates it, discovers /v1/models and stores it
 * encrypted. Everything shown after connecting comes from the backend (health, catalog, capabilities).
 */
export function CraxConnect({
  app,
  onViewModels,
}: {
  app: Workspace;
  onViewModels: (models: Models) => void;
}) {
  const key = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [models, setModels] = useState<Models>([]);
  const provider: ProviderView | undefined = app.providers.find((p) => p.providerId === "crax-gpt");
  const loadModels = async () => {
    const list = await app.invoke("model.list", { providerId: "crax-gpt" });
    if (list) setModels(list);
    return list ?? [];
  };
  useEffect(() => {
    if (provider) void loadModels();
  }, [provider?.health, provider?.modelsDiscovered]);
  const connect = async () => {
    const apiKey = key.current?.value ?? "";
    if (key.current) key.current.value = "";
    if (!apiKey.trim()) {
      setNotice("Paste the API key you created on crax-gpt.");
      return;
    }
    setBusy(true);
    setNotice("Checking the key and discovering models…");
    const result = await app.invoke("provider.connect", { providerId: "crax-gpt", apiKey, baseUrl: "", model: "" });
    if (result) {
      app.setProviders(result);
      const connected = result.find((p) => p.providerId === "crax-gpt");
      setNotice(connected ? `crax-gpt: ${healthLabel[connected.health] ?? connected.health}` : "Connection saved.");
    } else setNotice("");
    setBusy(false);
  };
  const refresh = async () => {
    setBusy(true);
    await app.invoke("provider.refresh", {});
    const providers = await app.invoke("provider.list", {});
    if (providers) app.setProviders(providers);
    await loadModels();
    setBusy(false);
  };
  const open = async () => {
    const result = await app.invoke("provider.openLink", { providerId: "crax-gpt", kind: "apiKey" });
    setNotice(result?.opened ? "crax-gpt opened in your browser. Sign in, create an API key, then paste it below." : "crax-gpt could not be opened from here. Visit gpt.crax.lol in your browser.");
  };
  const count = (field: "tools" | "streaming") => ({
    yes: models.filter((m) => m.capabilities[field] === true).length,
    unknown: models.filter((m) => m.capabilities[field] === null).length,
  });
  const tools = count("tools"), streaming = count("streaming");
  const capability = (value: { yes: number; unknown: number }) =>
    value.yes ? `✓ ${value.yes} confirmed${value.unknown ? ` · ${value.unknown} not yet checked` : ""}` : value.unknown ? "Checked on first use" : "Not supported";

  return (
    <section className="v4-crax" aria-labelledby="v4-connect-heading">
      <h3 id="v4-connect-heading">
        <ProviderLogo providerId="crax-gpt" size={18} /> {provider ? "crax-gpt" : "Connect crax-gpt"}
      </h3>
      {provider ? (
        <>
          <p className={provider.health === "HEALTHY" ? "good" : "muted"}>
            {provider.health === "HEALTHY" ? "● " : "○ "}
            {healthLabel[provider.health] ?? provider.health}
          </p>
          <p>{provider.modelsDiscovered} models discovered</p>
          <p className="muted">Streaming: {capability(streaming)}</p>
          <p className="muted">Tools: {capability(tools)}</p>
          <p className="muted">API key: ••••••••{provider.keyHint ?? ""}</p>
          <div className="v4-actions">
            <button type="button" disabled={!models.length} onClick={() => onViewModels(models)}>
              View models
            </button>
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={13} /> {busy ? "Refreshing…" : "Refresh models"}
            </button>
          </div>
          <details>
            <summary>Replace API key</summary>
            <KeyForm keyRef={key} busy={busy} onConnect={() => void connect()} />
          </details>
        </>
      ) : (
        <>
          <ol className="v4-steps">
            <li>
              <button type="button" onClick={() => void open()}>
                Open crax-gpt <ExternalLink size={13} />
              </button>
              <small className="muted">Sign in and create an API key.</small>
            </li>
            <li>
              <KeyForm keyRef={key} busy={busy} onConnect={() => void connect()} />
            </li>
          </ol>
          <small className="muted">
            ALTREX sets up everything else: it checks the key, discovers the available models and keeps the key encrypted on this computer.
          </small>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

function KeyForm({ keyRef, busy, onConnect }: { keyRef: React.RefObject<HTMLInputElement | null>; busy: boolean; onConnect: () => void }) {
  return (
    <form
      className="v4-crax-key"
      onSubmit={(e) => {
        e.preventDefault();
        onConnect();
      }}
    >
      <label>
        API key
        <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} aria-label="crax-gpt API key" />
      </label>
      <button className="primary" disabled={busy}>
        {busy ? "Connecting…" : "Connect"}
      </button>
    </form>
  );
}
