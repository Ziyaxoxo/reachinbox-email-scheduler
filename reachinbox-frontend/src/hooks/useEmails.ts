"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/endpoints";

export interface EmailsParams {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  from?: string;
  to?: string;
}

export function useEmails(params: EmailsParams = {}) {
  const query = useQuery({
    queryKey: ["emails", "sent", params],
    queryFn: () => api.emails.sent(params),
    staleTime: 30 * 1000,
    // Same reasoning as useSchedules: a sent row appears server-side with
    // nothing to notify the browser, and the poll is also what holds the free
    // instance awake so the consumer keeps draining.
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });

  return {
    emails: query.data?.items ?? [],
    pagination: query.data?.pagination,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
