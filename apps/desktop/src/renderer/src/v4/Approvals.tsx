import { useEffect, useState } from "react";
import type { CommandResponse } from "@altrex/contracts";
import { ShieldAlert } from "lucide-react";
import { Dialog } from "../components/primitives";
import type { Invoke } from "./useWorkspace";

export function Approvals({
  pending,
  invoke,
  onRefresh,
}: {
  pending: CommandResponse<"permission.pending">;
  invoke: Invoke;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [hidden, setHidden] = useState(false);
  const request = pending[0];
  // A different approval request re-opens the dialog; hiding applies only to the one that was dismissed.
  useEffect(() => setHidden(false), [request?.approvalId]);
  if (!request) return null;
  const respond = async (
    decision: "approve" | "deny",
    scope: "once" | "task",
  ) => {
    setBusy(true);
    await invoke("permission.respond", {
      approvalId: request.approvalId,
      decision,
      scope,
    });
    await onRefresh();
    setBusy(false);
  };
  if (hidden)
    return (
      <button className="v4-approval-reminder" onClick={() => setHidden(false)}>
        <ShieldAlert size={16} />
        {pending.length} approval waiting
      </button>
    );
  return (
    <Dialog
      title="Approval required"
      onClose={() => setHidden(true)}
      className="v4-dialog"
    >
      <header>
        <ShieldAlert size={20} />
        <h2>Approval required</h2>
      </header>
      <p>
        ALTREX wants to use <strong>{request.tool}</strong>.
      </p>
      <pre>{request.summary}</pre>
      <div className="v4-warning">
        <strong>{request.risk} risk</strong>
        <p>{request.reason}</p>
      </div>
      <p>Capability: {request.capability}</p>
      {request.agentReason && (
        <p>Agent-provided reason: {request.agentReason}</p>
      )}
      <small>
        Task {request.taskId}. Allowing this task covers this capability and
        exact command only. Forbidden actions cannot be approved.
      </small>
      <footer>
        <button disabled={busy} onClick={() => void respond("deny", "once")}>
          Deny
        </button>
        {request.risk !== "FORBIDDEN" && (
          <>
            <button
              disabled={busy}
              onClick={() => void respond("approve", "task")}
            >
              Allow for this task
            </button>
            <button
              disabled={busy}
              className="primary"
              onClick={() => void respond("approve", "once")}
            >
              Allow once
            </button>
          </>
        )}
      </footer>
    </Dialog>
  );
}
