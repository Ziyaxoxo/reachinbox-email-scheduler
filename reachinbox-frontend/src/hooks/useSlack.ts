"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/endpoints";
import { useToastStore } from "../store/toastStore";
import { useRouter } from "next/navigation";

export function useSlack() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const statusQuery = useQuery({
    queryKey: ["slack", "status"],
    queryFn: () => api.slack.status(),
    staleTime: 60 * 1000,
  });

  const connectMutation = useMutation({
    mutationFn: () => api.slack.connect(),
    onSuccess: (data) => {
      router.push(data.url);
    },
    onError: (error) => {
      addToast({
        type: "error",
        title: "Slack connection failed",
        message: error instanceof Error ? error.message : "An error occurred",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api.slack.disconnect(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["slack"] });
      addToast({
        type: "info",
        title: "Slack disconnected",
        message: "Rate limit notifications will no longer be sent to Slack.",
      });
    },
    onError: (error) => {
      addToast({
        type: "error",
        title: "Failed to disconnect Slack",
        message: error instanceof Error ? error.message : "An error occurred",
      });
    },
  });

  return {
    isConnected: statusQuery.data?.connected ?? false,
    workspaceId: statusQuery.data?.workspaceId,
    destinationRef: statusQuery.data?.destinationRef,
    isLoading: statusQuery.isLoading,
    connect: connectMutation.mutate,
    isConnecting: connectMutation.isPending,
    disconnect: disconnectMutation.mutate,
    isDisconnecting: disconnectMutation.isPending,
  };
}
