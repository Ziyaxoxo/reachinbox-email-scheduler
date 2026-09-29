"use client";

import { useState, useEffect } from "react";
import { useSchedules, type SchedulesParams } from "../hooks/useSchedules";
import { TableSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { StatusBadge } from "./StatusBadge";
import { Pagination } from "./Pagination";
import { format } from "date-fns";
import { Calendar, ExternalLink } from "lucide-react";

const PAGE_SIZE = 20;

export function ScheduledList({
  filter = "",
  status = "",
}: {
  filter?: string;
  status?: string;
}) {
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState("");

  // Debounce so typing does not issue a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(filter);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  const params: SchedulesParams = {
    page,
    limit: PAGE_SIZE,
    ...(debounced ? { search: debounced } : {}),
    ...(status ? { status } : {}),
  };

  const { schedules, pagination, isLoading, isFetching, isError, refetch } =
    useSchedules(params);

  if (isLoading) return <TableSkeleton />;

  if (isError) {
    return (
      <ErrorState
        title="Couldn’t load scheduled email"
        message="We couldn’t reach the scheduler. Check your connection and try again."
        onRetry={() => refetch()}
      />
    );
  }

  if (schedules.length === 0) {
    return debounced ? (
      <EmptyState
        title="No matches"
        message={`Nothing in your scheduled list matches “${debounced}”.`}
      />
    ) : (
      <EmptyState
        title="Nothing scheduled yet"
        message="Compose your first campaign and it will appear here before it sends."
      />
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="list-head">
        <span className="w-[132px] shrink-0">Campaign</span>
        <span className="flex-1">Email</span>
        <span className="w-[104px] shrink-0 text-right">Starts</span>
        <span className="w-7" />
      </div>

      <ul className={isFetching ? "opacity-60 transition-opacity" : undefined}>
        {schedules.map((schedule) => (
          <li key={schedule.id} className="list-row">
            <div className="list-row-recipient">
              <span
                className="truncate"
                title={schedule.firstRecipientEmail ?? undefined}
              >
                {schedule.firstRecipientEmail ?? "No recipients"}
              </span>
              {schedule.recipientCount > 1 && (
                <span className="list-row-recipient-more">
                  +{schedule.recipientCount - 1}
                </span>
              )}
            </div>

            <div className="list-row-main">
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge status={schedule.status} />
                <span className="list-row-subject">{schedule.subject}</span>
              </div>
              <p className="list-row-desc">
                {schedule.hourlyLimit}/hour · {formatDelay(schedule.delayMs)} gap
              </p>
            </div>

            <div className="flex items-center gap-1.5 w-[104px] shrink-0 justify-end">
              <Calendar className="w-3.5 h-3.5 text-ink-faint" aria-hidden="true" />
              <span className="list-row-time">
                {format(new Date(schedule.startAt), "MMM d, HH:mm")}
              </span>
            </div>

            <a
              className="list-row-action"
              href={`/schedules/${schedule.id}`}
              aria-label={`Open schedule ${schedule.subject}`}
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>

      {pagination ? (
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          onPageChange={setPage}
        />
      ) : null}

      <p className="px-4 py-2 text-2xs text-ink-faint border-t border-line">
        Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </p>
    </div>
  );
}

function formatDelay(ms: number): string {
  if (ms <= 0) return "no";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
