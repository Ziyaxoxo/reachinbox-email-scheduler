"use client";

import { useState, useEffect } from "react";
import { format } from "date-fns";
import { ExternalLink } from "lucide-react";
import { useEmails, type EmailsParams } from "../hooks/useEmails";
import { TableSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { StatusBadge } from "./StatusBadge";
import { Pagination } from "./Pagination";

const PAGE_SIZE = 20;

export function SentList({
  filter = "",
  status = "",
}: {
  filter?: string;
  status?: string;
}) {
  const [page, setPage] = useState(1);
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(filter);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  const params: EmailsParams = {
    page,
    limit: PAGE_SIZE,
    ...(debounced ? { search: debounced } : {}),
    ...(status ? { status } : {}),
  };

  const { emails, pagination, isLoading, isFetching, isError, refetch } =
    useEmails(params);

  if (isLoading) return <TableSkeleton />;

  if (isError) {
    return (
      <ErrorState
        title="Couldn’t load sent email"
        message="We couldn’t reach the delivery log. Check your connection and try again."
        onRetry={() => refetch()}
      />
    );
  }

  if (emails.length === 0) {
    return debounced ? (
      <EmptyState
        title="No matches"
        message={`Nothing in your sent list matches “${debounced}”.`}
      />
    ) : (
      <EmptyState
        title="No sent email yet"
        message="Delivered messages will show up here with their provider reference."
      />
    );
  }

  return (
    <div className="panel overflow-hidden">
      <div className="list-head">
        <span className="w-[200px] shrink-0">Recipient</span>
        <span className="flex-1">Email</span>
        <span className="w-[104px] shrink-0 text-right">Sent</span>
        <span className="w-7" />
      </div>

      <ul className={isFetching ? "opacity-60 transition-opacity" : undefined}>
        {emails.map((email) => (
          <li key={email.id} className="list-row">
            <div className="list-row-recipient max-sm:w-[200px]">
              <span className="truncate" title={email.normalizedEmail}>
                {email.normalizedEmail}
              </span>
            </div>

            <div className="list-row-main">
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge status={email.status} />
                <span className="list-row-subject">{email.subject}</span>
              </div>
              <p className="list-row-desc">
                {email.status === "sent" && email.providerId
                  ? `Delivered · ref ${email.providerId.slice(0, 24)}`
                  : email.status === "failed" && email.failureCode
                    ? `Failed · ${email.failureCode}`
                    : `Attempt ${email.attempt ?? 1}`}
              </p>
            </div>

            <div className="w-[104px] shrink-0 text-right">
              <span className="list-row-time">
                {format(new Date(email.sentAt ?? email.updatedAt), "MMM d, HH:mm")}
              </span>
            </div>

            <a
              className="list-row-action"
              href={`/sent/${email.id}`}
              aria-label={`Open email to ${email.normalizedEmail}`}
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
