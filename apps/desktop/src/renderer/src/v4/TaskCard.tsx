import { useMemo, useState } from "react";
import { Check, Circle, ChevronRight, ShieldCheck, Square } from "lucide-react";
import type {
  AltrexEvent,
  Evidence,
  TaskSummary,
  Verdict,
} from "@altrex/contracts";
import { MessageContent } from "../components/MessageContent";
import { label, taskView, terminalStates } from "./state";
import type { ProviderView } from "@altrex/contracts";
import { RouteBadge } from "./RouteBadge";
import { ProviderLogo, RouteLabel } from "./logos";

export function Status({ value }: { value: string }) {
  const good = ["VERIFIED", "PASS", "HEALTHY", "completed", "approve"].includes(
    value,
  );
  const bad = ["FAILED", "FAIL", "ERROR", "AUTH_ERROR", "failed"].includes(
    value,
  );
  return (
    <span className={`v4-status ${good ? "good" : bad ? "bad" : "neutral"}`}>
      {good ? <Check size={12} /> : <Circle size={8} />}
      {label(value)}
    </span>
  );
}
export function EvidenceRow({
  evidence,
  attempt,
}: {
  evidence: Evidence;
  attempt?: number;
}) {
  return (
    <details className="v4-evidence">
      <summary>
        <span>
          {label(evidence.name)}
          {attempt ? ` · attempt ${attempt}` : ""}
        </span>
        <Status value={evidence.status} />
        <span className="muted">
          {(evidence.durationMs / 1000).toFixed(1)}s
        </span>
      </summary>
      {evidence.parsed && (
        <p>
          {Object.entries(evidence.parsed)
            .filter(([key]) => key !== "failingTests")
            .map(([key, count]) => `${count} ${key}`)
            .join(" · ")}
        </p>
      )}
      <p className="mono">{evidence.argv.join(" ")}</p>
      <p>
        Exit code: {evidence.exitCode ?? "Unavailable"}
        {evidence.timedOut ? " · Timed out" : ""}
      </p>
      {evidence.note && <p>{evidence.note}</p>}
      {evidence.parsed?.failingTests?.map((name) => (
        <p key={name} className="bad">
          {name}
        </p>
      ))}
      {evidence.outputTail && <pre>{evidence.outputTail}</pre>}
    </details>
  );
}
export function Verification({
  verdict,
  verified,
}: {
  verdict: Verdict;
  verified: boolean;
}) {
  return (
    <section className="v4-verification" aria-label="Verification">
      <header>
        <ShieldCheck size={17} />
        <strong>
          {verified ? "Verified result" : "Verification evidence"}
        </strong>
      </header>
      <div className="v4-checks">
        {verdict.checks.map((check, i) => (
          <div key={`${check.name}-${i}`}>
            <span>{label(check.name)}</span>
            <Status value={check.status} />
            {check.summary && <small>{check.summary}</small>}
          </div>
        ))}
        <div>
          <span>Review</span>
          <Status value={verdict.review.decision} />
          <small>{verdict.review.independence}</small>
        </div>
      </div>
      {verdict.reasons.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {verdict.review.note && <p>{verdict.review.note}</p>}
      {!!verdict.review.findings.length && (
        <details>
          <summary>Review findings ({verdict.review.findings.length})</summary>
          {verdict.review.findings.map((finding, i) => (
            <p key={i}>
              <strong>{finding.severity}</strong> {finding.file}
              {finding.line ? `:${finding.line}` : ""} — {finding.description}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
export function TaskCard({
  task,
  events,
  prompt,
  onSelect,
  onChanges,
  onCancel,
  onRetry,
  providers = [],
}: {
  task: TaskSummary;
  events: AltrexEvent[];
  prompt?: string | undefined;
  onSelect: () => void;
  onChanges: () => void;
  onCancel: () => void;
  onRetry: (prompt: string) => void;
  /** Provider views, for the route badge status. */
  providers?: ProviderView[];
}) {
  const view = useMemo(() => taskView(task, events), [task, events]),
    [expanded, setExpanded] = useState(false);
  const running = !terminalStates.has(view.state);
  const candidates = events.filter(
      (event) => event.type === "tournament.candidate",
    ),
    selection = [...events]
      .reverse()
      .find((event) => event.type === "tournament.selected");
  return (
    <article className="v4-task" aria-label={`Task: ${task.title}`}>
      <div className="v4-user">
        <span className="eyebrow">YOU</span>
        <p>{prompt ?? task.title}</p>
      </div>
      <div className="v4-task-heading">
        <button className="v4-task-state" onClick={onSelect}>
          <Status value={view.state} />
        </button>
        <time className="muted" dateTime={task.createdAt}>
          {new Date(task.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        <RouteBadge events={events} providers={providers} compact />
        {running && (
          <button className="quiet" onClick={onCancel}>
            <Square size={12} />
            Stop task
          </button>
        )}
      </div>
      {running && (
        <p role="status" className="v4-activity">
          {view.activity || label(view.state)}
        </p>
      )}
      {view.state === "INTERRUPTED" && (
        <div className="v4-warning">
          <strong>ALTREX closed before this task finished.</strong>
          <p>
            Commands will not resume automatically. Review changes or describe
            what to do next.
          </p>
          <button onClick={() => onRetry(task.title)}>
            Use request in a new task
          </button>
        </div>
      )}
      {view.state === "COMPLETED_UNVERIFIED" && (
        <p className="v4-warning">
          Task completed, but ALTREX could not fully verify the result.
        </p>
      )}
      {view.reason && (
        <p className={view.state === "FAILED" ? "bad" : "muted"}>
          {view.reason}
        </p>
      )}
      {view.notices.map((notice, i) => (
        <p className="v4-notice" key={i}>
          {view.noticeRoutes[i] && (
            <ProviderLogo
              providerId={view.noticeRoutes[i]!.providerId}
              model={view.noticeRoutes[i]!.model}
            />
          )}{" "}
          {notice}
        </p>
      ))}
      {view.text && (
        <>
          <MessageContent
            content={expanded ? view.text : view.text.slice(0, 24000)}
          />
          {view.text.length > 24000 && (
            <button onClick={() => setExpanded(!expanded)}>
              {expanded ? "Collapse response" : "Show full response"}
            </button>
          )}
        </>
      )}
      {view.verdict && (
        <Verification
          verdict={view.verdict}
          verified={view.state === "VERIFIED"}
        />
      )}
      {view.files.length > 0 && (
        <button className="v4-link" onClick={onChanges}>
          {view.files.length} changed{" "}
          {view.files.length === 1 ? "file" : "files"}
          <ChevronRight size={14} />
        </button>
      )}
      {(view.stages.length > 0 || view.agents.length > 0) && (
        <details className="v4-work">
          <summary>Work details · {view.agents.length} agent runs</summary>
          <div className="v4-stages">
            {view.stages.map((stage) => (
              <span key={stage}>{label(stage)}</span>
            ))}
          </div>
          {view.agents.map((agent) => (
            <div key={agent.agentId} className="v4-agent">
              <strong>{label(agent.role)}</strong>
              <Status value={agent.status} />
              <p>{agent.summary ?? agent.label}</p>
              {(agent.providerId || /codex/i.test(agent.label)) && (
                <small>
                  <RouteLabel
                    providerId={agent.providerId ?? "codex"}
                    model={agent.model}
                    compact
                  />
                </small>
              )}
            </div>
          ))}
          {events
            .filter((e) => e.type === "repair.started")
            .map((e) => (
              <p key={e.id}>
                Repair {e.payload.attempt} of {e.payload.limit}:{" "}
                {label(e.payload.reason)}
                {e.payload.escalated ? " · Escalated" : ""}
              </p>
            ))}
        </details>
      )}
      {candidates.length > 0 && (
        <details className="v4-work">
          <summary>Compare solutions</summary>
          {candidates.map((event) => (
            <div key={event.id}>
              <h4>
                Solution {event.payload.candidate + 1} · {event.payload.status}
              </h4>
              <p>
                {event.payload.changedFiles} changed files ·{" "}
                {event.payload.conflicts} conflicts
              </p>
              {event.payload.checks.map((check) => (
                <p key={check.name}>
                  {label(check.name)}: {check.status}
                </p>
              ))}
              {event.payload.error && (
                <p className="bad">{event.payload.error}</p>
              )}
            </div>
          ))}
          {selection?.type === "tournament.selected" && (
            <>
              <p>
                Selected:{" "}
                {selection.payload.winner === null
                  ? "No eligible solution"
                  : `Solution ${selection.payload.winner + 1}`}
              </p>
              {selection.payload.ranking.map((rank) => (
                <p key={rank.candidate}>
                  Solution {rank.candidate + 1}: {rank.reasons.join("; ")}
                </p>
              ))}
            </>
          )}
        </details>
      )}
      {view.state === "FAILED" && (
        <button onClick={() => onRetry(prompt ?? task.title)}>
          Edit and retry
        </button>
      )}
    </article>
  );
}
