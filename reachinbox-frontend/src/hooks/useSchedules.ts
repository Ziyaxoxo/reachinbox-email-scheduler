"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/endpoints";
import { useToastStore } from "../store/toastStore";
import type { CreateScheduleRequest } from "../lib/api/types";

export interface SchedulesParams {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
}

export function useSchedules(params: SchedulesParams = {}) {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const query = useQuery({
    queryKey: ["schedules", params],
    queryFn: () => api.schedules.list(params),
    staleTime: 30 * 1000,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateScheduleRequest) => api.schedules.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      addToast({
        type: "success",
        title: "Schedule created",
        message: "Your email schedule has been created successfully.",
      });
    },
    onError: (error) => {
      addToast({
        type: "error",
        title: "Failed to create schedule",
        message: error instanceof Error ? error.message : "An error occurred",
      });
    },
  });

  return {
    schedules: query.data?.items ?? [],
    pagination: query.data?.pagination,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    /**
     * `idempotencyKey` is required so the caller controls it. A stable key
     * across retries is what makes a retried create replay the original
     * schedule instead of creating a second one.
     */
    createSchedule: (data: CreateScheduleRequest) => createMutation.mutate(data),
    isCreating: createMutation.isPending,
  };
}
