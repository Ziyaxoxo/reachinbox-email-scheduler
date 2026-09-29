import { Inbox } from "lucide-react";

interface EmptyStateProps {
  title: string;
  message: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className="panel">
      <div className="state-wrap">
        <div className="state-icon-muted">
          <Inbox className="w-5 h-5" aria-hidden="true" />
        </div>
        <h3 className="state-title">{title}</h3>
        <p className="state-body">{message}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}
