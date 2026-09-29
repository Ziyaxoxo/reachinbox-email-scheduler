import { clsx } from "clsx";

type Status = "scheduled" | "queued" | "sending" | "sent" | "failed" | "cancelled";

const statusConfig: Record<Status, { label: string; className: string }> = {
  scheduled: { label: "Scheduled", className: "chip chip-pending" },
  queued: { label: "Queued", className: "chip chip-queued" },
  sending: { label: "Sending", className: "chip chip-progress" },
  sent: { label: "Sent", className: "chip chip-sent" },
  failed: { label: "Failed", className: "chip chip-failed" },
  cancelled: { label: "Cancelled", className: "chip chip-muted" },
};

export function StatusBadge({ status }: { status: Status }) {
  const config = statusConfig[status] ?? statusConfig.scheduled;

  return (
    <span className={clsx(config.className)}>
      {config.label}
    </span>
  );
}
