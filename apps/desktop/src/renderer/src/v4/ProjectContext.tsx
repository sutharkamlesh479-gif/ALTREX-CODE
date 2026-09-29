import { useEffect, useState } from "react";
import type { CommandResponse } from "@altrex/contracts";
import type { Invoke } from "./useWorkspace";
export function ProjectContext({
  invoke,
  projectPath,
}: {
  invoke: Invoke;
  projectPath: string;
}) {
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState<CommandResponse<"repo.search">>(),
    [context, setContext] = useState<CommandResponse<"context.preview">>(),
    [profile, setProfile] = useState<CommandResponse<"repo.profile">>(),
    [git, setGit] = useState<CommandResponse<"git.diff">>(),
    [memory, setMemory] = useState<CommandResponse<"memory.list">>(),
    [key, setKey] = useState(""),
    [value, setValue] = useState("");
  useEffect(() => {
    let live = true;
    void invoke("repo.profile", { projectPath }).then((result) => {
      if (live) setProfile(result);
    });
    return () => {
      live = false;
    };
  }, [invoke, projectPath]);
  const lookup = async (kind: "search" | "context") => {
    setBusy(true);
    if (kind === "search")
      setSearch(
        await invoke("repo.search", {
          projectPath,
          pattern: query,
          maxResults: 100,
        }),
      );
    else
      setContext(
        await invoke("context.preview", {
          projectPath,
          task: query,
          maxChars: 30000,
        }),
      );
    setBusy(false);
  };
  return (
    <section>
      <h3>Project context</h3>
      <p className="muted">
        Search project files or preview the files a request would select.
        Previewing context does not call a model.
      </p>
      <form
        className="v4-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup("search");
        }}
      >
        <input
          aria-label="Search project or describe context"
          value={query}
          maxLength={1000}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search code or describe your task…"
        />
        <button disabled={busy || !query.trim()}>Search files</button>
        <button
          type="button"
          disabled={busy || !query.trim()}
          onClick={() => void lookup("context")}
        >
          Preview context
        </button>
      </form>
      {busy && <p role="status">Inspecting project…</p>}
      {search && (
        <>
          <p>
            {search.matches.length} matches
            {search.truncated
              ? " · More results available; narrow your search."
              : ""}
          </p>
          {search.matches.map((match, i) => (
            <div className="v4-search-result" key={i}>
              <code>
                {match.path}:{match.line}
              </code>
              <pre>{match.text}</pre>
            </div>
          ))}
        </>
      )}
      {context && (
        <>
          <h4>Proposed context</h4>
          {context.items.map((item, i) => (
            <div className="v4-row" key={i}>
              <code>{item.path}</code>
              <small>
                {item.kind} · {item.reason} · {item.chars} characters
              </small>
            </div>
          ))}
          {!context.items.length && <p>No context selected.</p>}
        </>
      )}
      <details className="v4-work">
        <summary>Project profile & declared checks</summary>
        {profile ? (
          <>
            <p>
              {profile.languages
                .map((l) => `${l.language} (${l.files})`)
                .join(" · ")}
            </p>
            <p>
              {profile.frameworks.join(" · ")} {profile.packageManager}
            </p>
            {profile.commands.map((check) => (
              <p key={check.kind}>
                <strong>{check.kind}</strong>{" "}
                <code>{check.argv.join(" ")}</code> — {check.source}
              </p>
            ))}
            {!profile.commands.length && (
              <p>No declared checks found. Tasks may complete unverified.</p>
            )}
          </>
        ) : (
          <p>Project profile unavailable.</p>
        )}
      </details>
      <details className="v4-work">
        <summary>Working tree changes</summary>
        <button
          onClick={() =>
            void invoke("git.diff", { projectPath, maxBytes: 100000 }).then(
              setGit,
            )
          }
        >
          Load Git changes
        </button>
        {git && (
          <>
            <pre>{git.diff || "No tracked differences from HEAD."}</pre>
            {git.truncated && <p>Diff truncated by the backend.</p>}
          </>
        )}
      </details>
      <details className="v4-work">
        <summary>Project memory</summary>
        <p>
          ALTREX.md contains your own rules. Memory below records user notes and
          backend evidence.
        </p>
        <button
          onClick={() =>
            void invoke("memory.list", { projectPath }).then(setMemory)
          }
        >
          Load memory
        </button>
        {memory?.map((fact) => (
          <div className="v4-row" key={fact.key}>
            <div>
              <strong>{fact.key}</strong>
              <p>{fact.value}</p>
              <small>
                {fact.source} · {fact.confidence} ·{" "}
                {new Date(fact.lastVerifiedAt).toLocaleString()}
              </small>
            </div>
            <button
              onClick={() =>
                void invoke("memory.forget", {
                  projectPath,
                  key: fact.key,
                }).then((result) => {
                  if (result?.removed)
                    setMemory((items) =>
                      items?.filter((item) => item.key !== fact.key),
                    );
                })
              }
            >
              Forget
            </button>
          </div>
        ))}
        {memory?.length === 0 && <p>No memory recorded.</p>}
        <form
          className="v4-search-form"
          onSubmit={(e) => {
            e.preventDefault();
            void invoke("memory.remember", { projectPath, key, value }).then(
              async (result) => {
                if (result) {
                  setValue("");
                  setMemory(await invoke("memory.list", { projectPath }));
                }
              },
            );
          }}
        >
          <input
            aria-label="Memory key"
            placeholder="Note name"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <input
            aria-label="Memory value"
            placeholder="What should ALTREX remember?"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button disabled={!key.trim() || !value.trim()}>Remember</button>
        </form>
      </details>
    </section>
  );
}
