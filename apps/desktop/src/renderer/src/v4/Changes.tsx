import { useEffect, useMemo, useState } from "react";
import type {
  CommandResponse,
  RestorePlan,
  RestoreResult,
} from "@altrex/contracts";
import { Dialog } from "../components/primitives";
import type { Invoke } from "./useWorkspace";

/** Linear, bounded alignment: matching prefix/suffix, removed/added middle. No quadratic LCS. */
export function diffLines(before: string | null, current: string | null) {
  const left = before === null ? [] : before.split("\n"),
    right = current === null ? [] : current.split("\n");
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  return [
    ...left
      .slice(0, prefix)
      .map((text, i) => ({ kind: "same", text, old: i + 1, next: i + 1 })),
    ...left
      .slice(prefix, left.length - suffix)
      .map((text, i) => ({
        kind: "removed",
        text,
        old: prefix + i + 1,
        next: null,
      })),
    ...right
      .slice(prefix, right.length - suffix)
      .map((text, i) => ({
        kind: "added",
        text,
        old: null,
        next: prefix + i + 1,
      })),
    ...right
      .slice(right.length - suffix)
      .map((text, i) => ({
        kind: "same",
        text,
        old: left.length - suffix + i + 1,
        next: right.length - suffix + i + 1,
      })),
  ];
}
export function Changes({
  invoke,
  files,
  checkpoint,
  changes,
  truncated,
}: {
  invoke: Invoke;
  files: string[];
  checkpoint?: string | undefined;
  changes: Map<string, string>;
  truncated: boolean;
}) {
  const [path, setPath] = useState(files[0] ?? ""),
    [diff, setDiff] = useState<CommandResponse<"checkpoint.diff">>(),
    [loading, setLoading] = useState(false),
    [page, setPage] = useState(0),
    [query, setQuery] = useState("");
  useEffect(() => {
    setPath(files[0] ?? "");
    setDiff(undefined);
  }, [checkpoint]);
  useEffect(() => {
    let live = true;
    setDiff(undefined);
    setPage(0);
    if (!path || !checkpoint) return;
    setLoading(true);
    void invoke("checkpoint.diff", { checkpointId: checkpoint, path }).then(
      (value) => {
        if (live) {
          setDiff(value);
          setLoading(false);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [path, checkpoint, invoke]);
  const lines = useMemo(
    () => (diff ? diffLines(diff.before, diff.current) : []),
    [diff],
  );
  const filtered = files.filter((file) =>
    file.toLowerCase().includes(query.toLowerCase()),
  );
  const [fileLimit, setFileLimit] = useState(100);
  if (!files.length)
    return (
      <p className="v4-empty">
        Changed files will appear here when ALTREX reports a file change.
      </p>
    );
  return (
    <div className="v4-diff-layout">
      <nav aria-label="Changed files">
        <input
          aria-label="Filter changed files"
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {filtered.slice(0, fileLimit).map((file) => (
          <button
            key={file}
            title={file}
            aria-current={file === path ? "true" : undefined}
            onClick={() => setPath(file)}
          >
            <span>{file}</span>
            <small>{changes.get(file) ?? "changed"}</small>
          </button>
        ))}
        {filtered.length > fileLimit && (
          <button onClick={() => setFileLimit((n) => n + 100)}>
            Show 100 more files
          </button>
        )}
        {truncated && <p>Backend file list is partial.</p>}
      </nav>
      <section aria-label="File diff">
        <header className="v4-panel-heading">
          <strong>{path}</strong>
          <div>
            <button
              disabled={files.indexOf(path) <= 0}
              onClick={() => setPath(files[files.indexOf(path) - 1]!)}
            >
              Previous
            </button>
            <button
              disabled={files.indexOf(path) >= files.length - 1}
              onClick={() => setPath(files[files.indexOf(path) + 1]!)}
            >
              Next
            </button>
          </div>
        </header>
        {!checkpoint && (
          <p className="v4-empty">
            No recovery checkpoint is available for this task. Use project Git
            changes to inspect the current tree.
          </p>
        )}
        {loading && <p role="status">Loading diff…</p>}
        {diff?.changedSinceTask && (
          <p className="v4-warning">
            This file has changed since the task finished. The right side shows
            its current content.
          </p>
        )}
        {diff?.binary ? (
          <p className="v4-empty">
            Binary or large file. Text preview is unavailable.
          </p>
        ) : (
          diff && (
            <>
              <div className="v4-diff-legend">
                <span>− Before task</span>
                <span>+ Current file</span>
              </div>
              <div className="v4-diff-code">
                {lines.slice(page * 300, (page + 1) * 300).map((line, i) => (
                  <div key={page * 300 + i} className={`diff-${line.kind}`}>
                    <span>{line.old}</span>
                    <span>{line.next}</span>
                    <code>
                      {line.kind === "added"
                        ? "+"
                        : line.kind === "removed"
                          ? "−"
                          : " "}{" "}
                      {line.text}
                    </code>
                  </div>
                ))}
              </div>
              {lines.length > 300 && (
                <div className="v4-pagination">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((n) => n - 1)}
                  >
                    Previous lines
                  </button>
                  <span>
                    {page * 300 + 1}–{Math.min(lines.length, (page + 1) * 300)}{" "}
                    of {lines.length}
                  </span>
                  <button
                    disabled={(page + 1) * 300 >= lines.length}
                    onClick={() => setPage((n) => n + 1)}
                  >
                    Next lines
                  </button>
                </div>
              )}
            </>
          )
        )}
      </section>
    </div>
  );
}
export function Checkpoints({
  invoke,
  projectPath,
  busy,
}: {
  invoke: Invoke;
  projectPath: string;
  busy: boolean;
}) {
  const [checkpoints, setCheckpoints] =
      useState<CommandResponse<"checkpoint.list">>(),
    [plan, setPlan] = useState<RestorePlan>(),
    [result, setResult] = useState<RestoreResult>(),
    [working, setWorking] = useState(false);
  const load = async () =>
    setCheckpoints(await invoke("checkpoint.list", { projectPath }));
  useEffect(() => {
    let live = true;
    void invoke("checkpoint.list", { projectPath }).then((value) => {
      if (live) setCheckpoints(value);
    });
    return () => {
      live = false;
    };
  }, [invoke, projectPath]);
  const preview = async (checkpointId: string, scope: "task" | "all") => {
    setWorking(true);
    setPlan(await invoke("checkpoint.preview", { checkpointId, scope }));
    setWorking(false);
  };
  return (
    <section>
      <header className="v4-panel-heading">
        <div>
          <h3>Recovery checkpoints</h3>
          <p>
            ALTREX creates a checkpoint before editing. Review exactly what a
            restore would change.
          </p>
        </div>
        <button disabled={working} onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {checkpoints === undefined ? (
        <p className="v4-empty">Loading checkpoints…</p>
      ) : !checkpoints.length ? (
        <p className="v4-empty">
          No checkpoints yet. A write-capable task creates one automatically.
        </p>
      ) : (
        checkpoints.map((cp) => (
          <div className="v4-row" key={cp.checkpointId}>
            <div>
              <strong>{cp.label}</strong>
              <small>
                {new Date(cp.createdAt).toLocaleString()} ·{" "}
                {cp.changedByTask ?? "Unknown"} changed files
                {!cp.finalizedAt ? " · Unfinished task" : ""}
              </small>
            </div>
            <button
              disabled={busy || working}
              onClick={() =>
                void preview(cp.checkpointId, cp.finalizedAt ? "task" : "all")
              }
            >
              Preview restore
            </button>
          </div>
        ))
      )}
      {busy && (
        <p className="muted">
          Wait for the project’s active task before restoring.
        </p>
      )}
      {result && (
        <div className="v4-notice">
          <p>
            Restored {result.restored.length} files; removed{" "}
            {result.deleted.length}; preserved {result.conflicts.length}{" "}
            conflicts.
          </p>
          {result.conflicts.map((c) => (
            <p key={c.path}>
              {c.path}: {c.reason}
            </p>
          ))}
          {result.safetyCheckpointId && (
            <button
              disabled={working || busy}
              onClick={() => void preview(result.safetyCheckpointId!, "all")}
            >
              Preview undo restore
            </button>
          )}
        </div>
      )}
      {plan && (
        <Dialog
          title="Restore previous state"
          onClose={() => !working && setPlan(undefined)}
          className="v4-dialog"
        >
          <h2>Restore previous state</h2>
          <p>
            {plan.scope === "all"
              ? "This restores every difference since the checkpoint, including later edits. Review the affected paths carefully."
              : "Restore this task’s changes. Files edited afterward are preserved as conflicts."}
          </p>
          <div className="v4-restore-paths">
            {plan.restore.map((path) => (
              <p key={`r-${path}`}>Restore: {path}</p>
            ))}
            {plan.delete.map((path) => (
              <p key={`d-${path}`}>Remove: {path}</p>
            ))}
            {plan.conflicts.map((c) => (
              <p className="v4-warning" key={c.path}>
                Preserve: {c.path} ({c.reason})
              </p>
            ))}
          </div>
          {!plan.restore.length && !plan.delete.length && (
            <p>There are no restorable changes.</p>
          )}
          <p>A safety checkpoint allows you to undo this restore.</p>
          <footer>
            <button disabled={working} onClick={() => setPlan(undefined)}>
              Cancel
            </button>
            <button
              className="danger"
              disabled={
                working || busy || (!plan.restore.length && !plan.delete.length)
              }
              onClick={() => {
                setWorking(true);
                void invoke("checkpoint.restore", {
                  checkpointId: plan.checkpointId,
                  scope: plan.scope,
                }).then((value) => {
                  if (value) {
                    setResult(value);
                    setPlan(undefined);
                    void load();
                  }
                  setWorking(false);
                });
              }}
            >
              {working ? "Restoring…" : "Restore these changes"}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
