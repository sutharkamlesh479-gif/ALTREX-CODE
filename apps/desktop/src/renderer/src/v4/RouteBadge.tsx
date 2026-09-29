import { useEffect, useRef, useState } from "react";
import type { AltrexEvent, ProviderView } from "@altrex/contracts";
import { healthLabel, label } from "./state";
import { activeRoute } from "./state";
import { ProviderLogo, providerLabel } from "./logos";

/**
 * The provider/model the backend is actually using for a task (from routing events), with a compact
 * details popover. Renders nothing until the backend has selected a route.
 */
export function RouteBadge({
  events,
  providers,
  compact = false,
}: {
  events: AltrexEvent[];
  providers: ProviderView[];
  compact?: boolean;
}) {
  const route = activeRoute(events);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!route) return null;
  const provider = providers.find((p) => p.providerId === route.providerId);
  const shortModel = route.model.split("/").at(-1)!;
  const name = route.providerId === "codex" ? route.provider : providerLabel(route.providerId);
  return (
    <span className="v4-route" ref={box}>
      <button
        type="button"
        className={`v4-route-badge ${compact ? "compact" : ""}`}
        aria-label={`Active AI: ${name}, ${route.model}${route.afterFallback ? ", after fallback" : ""}`}
        aria-expanded={open}
        title={`${name} • ${route.model}`}
        onClick={() => setOpen(!open)}
      >
        <ProviderLogo providerId={route.providerId} model={route.model} />
        <span className="v4-route-text">
          {name}
          <span className="muted"> • {shortModel}</span>
        </span>
      </button>
      {open && (
        <span className="v4-route-popover" role="dialog" aria-label="Active AI details">
          <span>Provider</span>
          <strong>
            <ProviderLogo providerId={route.providerId} /> {name}
          </strong>
          <span>Model</span>
          <strong className="mono">{route.model}</strong>
          {route.mode && (
            <>
              <span>Mode</span>
              <strong>{label(route.mode)}</strong>
            </>
          )}
          <span>Status</span>
          <strong>
            {provider ? healthLabel[provider.health] ?? label(provider.health) : route.providerId === "codex" ? "External engine" : "Not checked"}
          </strong>
          {route.reason && (
            <>
              <span>Reason</span>
              <small>
                {route.afterFallback ? "After a fallback. " : ""}
                {route.reason}
              </small>
            </>
          )}
        </span>
      )}
    </span>
  );
}
