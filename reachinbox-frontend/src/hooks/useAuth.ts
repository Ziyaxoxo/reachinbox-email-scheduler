"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/endpoints";
import { useAuthStore } from "../store/authStore";
import { useToastStore } from "../store/toastStore";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function useAuth() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, setUser, setLoading, setError, logout, isLoading, isAuthenticated } = useAuthStore();
  const addToast = useToastStore((s) => s.addToast);

  const { isLoading: isFetching } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      try {
        const userData = await api.auth.me();
        setUser(userData);
        return userData;
      } catch (error) {
        if (error instanceof Error && "statusCode" in error && (error as { statusCode: number }).statusCode === 401) {
          setUser(null);
          router.push("/login");
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
    enabled: !user,
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => {
      logout();
      queryClient.clear();
      addToast({ type: "info", title: "Logged out", message: "You have been logged out successfully." });
      router.push("/login");
    },
    onError: (error) => {
      addToast({
        type: "error",
        title: "Logout failed",
        message: error instanceof Error ? error.message : "An error occurred",
      });
    },
  });

  useEffect(() => {
    if (!isFetching && !user) {
      setLoading(false);
    }
  }, [isFetching, user, setLoading]);

  return {
    user,
    isLoading: isLoading || isFetching,
    isAuthenticated,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
