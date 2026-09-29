"use client";

import { useToastStore } from "../store/toastStore";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";
import { clsx } from "clsx";

const ICONS = {
  success: { Icon: CheckCircle2, tone: "text-brand-600" },
  error: { Icon: XCircle, tone: "text-danger-500" },
  info: { Icon: Info, tone: "text-ink-muted" },
  warning: { Icon: AlertTriangle, tone: "text-warn-500" },
};

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-[340px] pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => {
        const { Icon, tone } = ICONS[toast.type];

        return (
          <div key={toast.id} className="toast" role="status">
            <Icon className={clsx("w-4 h-4 shrink-0 mt-px", tone)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="toast-title">{toast.title}</p>
              {toast.message ? <p className="toast-body">{toast.message}</p> : null}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="shrink-0 w-6 h-6 grid place-items-center rounded-[6px] text-ink-faint hover:text-ink hover:bg-surface-sunken transition-colors"
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
