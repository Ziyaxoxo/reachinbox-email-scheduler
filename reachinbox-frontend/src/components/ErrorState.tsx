import { AlertCircle, RefreshCw } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="panel">
      <div className="state-wrap" role="alert">
        <div className="state-icon-danger">
          <AlertCircle className="w-5 h-5" aria-hidden="true" />
        </div>
        <h3 className="state-title">{title}</h3>
        <p className="state-body">{message}</p>
        {onRetry ? (
          <button onClick={onRetry} className="btn-outline btn-sm mt-4">
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
