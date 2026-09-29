"use client";

import { useState } from "react";
import { MessageSquare, Unplug, Plug, AlertTriangle } from "lucide-react";
import { useSlack } from "../hooks/useSlack";

export function SlackConnect() {
  const {
    isConnected,
    workspaceId,
    destinationRef,
    isLoading,
    connect,
    disconnect,
    isDisconnecting,
  } = useSlack();
  const [confirm, setConfirm] = useState(false);

  if (isLoading) {
    return (
      <div className="panel p-4 flex items-center gap-3" aria-busy="true">
        <div className="sk w-9 h-9 rounded-ctl" />
        <div className="flex-1 space-y-1.5">
          <div className="sk h-3 w-32" />
          <div className="sk h-2.5 w-48" />
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-ctl grid place-items-center shrink-0 bg-surface-sunken">
          <MessageSquare
            className={`w-4 h-4 ${isConnected ? "text-brand-600" : "text-ink-faint"}`}
            aria-hidden="true"
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900">Slack notifications</p>
          <p className="text-2xs text-ink-faint truncate">
            {isConnected
              ? `Connected · ${workspaceId ?? "workspace"}${
                  destinationRef ? ` · #${destinationRef}` : ""
                }`
              : "Get alerted when a sender hits its hourly limit"}
          </p>
        </div>

        {isConnected ? (
          confirm ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  disconnect();
                  setConfirm(false);
                }}
                disabled={isDisconnecting}
                className="btn btn-sm bg-danger-500 text-white hover:bg-danger-600"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirm(false)}
                className="btn-ghost btn-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirm(true)}
              className="btn-ghost btn-sm"
              aria-label="Disconnect Slack"
            >
              <Unplug className="w-3.5 h-3.5" aria-hidden="true" />
              Disconnect
            </button>
          )
        ) : (
          <button onClick={() => connect()} className="btn-brand-outline btn-sm">
            <Plug className="w-3.5 h-3.5" aria-hidden="true" />
            Connect
          </button>
        )}
      </div>

      {confirm ? (
        <p className="mt-3 flex items-start gap-2 text-2xs text-warn-600 bg-warn-50 border border-warn-100 rounded-ctl px-2.5 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
          Rate-limit alerts will stop. You can reconnect at any time.
        </p>
      ) : null}
    </div>
  );
}
