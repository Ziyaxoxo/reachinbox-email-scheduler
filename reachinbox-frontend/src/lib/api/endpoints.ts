import { apiClient } from "./client";
import type {
  User,
  Schedule,
  PaginatedResponse,
  CreateScheduleRequest,
  CreateScheduleResponse,
  SentEmailRecord,
  SlackStatusResponse,
} from "./types";

export const api = {
  auth: {
    me: () => apiClient.get<User>("/me"),
    logout: () => apiClient.post<{ status: string }>("/auth/logout", {}),

    /**
     * Email + password sign-in.
     *
     * The server sets an HttpOnly session cookie, so there is no token to hold
     * in JS state and nothing to attach to later requests.
     */
    login: (credentials: { email: string; password: string }) =>
      apiClient.post<{ user: User }>("/auth/login", credentials),

    register: (details: { email: string; password: string; name?: string }) =>
      apiClient.post<{ user: User }>("/auth/register", details),

    /**
     * currentPassword is required only when the account already has one; the
     * server decides, and reports CURRENT_PASSWORD_REQUIRED if it is missing.
     */
    changePassword: (details: { currentPassword?: string; newPassword: string }) =>
      apiClient.post<{ status: string }>("/auth/change-password", details),

    updateProfile: (patch: { name?: string; avatar?: string | null }) =>
      apiClient.patch<User>("/me", patch),
  },

  schedules: {
    list: (params: { page?: number; limit?: number; status?: string; search?: string } = {}) => {
      const searchParams = new URLSearchParams();
      if (params.page) searchParams.set("page", String(params.page));
      if (params.limit) searchParams.set("limit", String(params.limit));
      if (params.status) searchParams.set("status", params.status);
      if (params.search) searchParams.set("search", params.search);
      return apiClient.get<PaginatedResponse<Schedule>>(`/schedules?${searchParams}`);
    },

    get: (id: string) => apiClient.get<Schedule>(`/schedules/${id}`),

    create: (data: CreateScheduleRequest) =>
      apiClient.post<CreateScheduleResponse>("/schedules", data, {
        // Same key as the body field so a retry of one logical create
        // replays the original schedule instead of creating a second one.
        idempotencyKey: data.idempotencyKey,
      }),
  },

  emails: {
    sent: (
      params: {
        page?: number;
        limit?: number;
        status?: string;
        search?: string;
        from?: string;
        to?: string;
      } = {},
    ) => {
      const searchParams = new URLSearchParams();
      if (params.page) searchParams.set("page", String(params.page));
      if (params.limit) searchParams.set("limit", String(params.limit));
      if (params.status) searchParams.set("status", params.status);
      if (params.search) searchParams.set("search", params.search);
      if (params.from) searchParams.set("from", params.from);
      if (params.to) searchParams.set("to", params.to);

      // Recipient-level records, not schedules: the Sent view needs a real
      // recipient address and delivery timestamp.
      return apiClient.get<PaginatedResponse<SentEmailRecord>>(
        `/emails/sent?${searchParams}`,
      );
    },
  },

  slack: {
    connect: () => apiClient.post<{ url: string; state: string }>("/slack/connect", {}),
    status: () => apiClient.get<SlackStatusResponse>("/slack/status"),
    disconnect: () => apiClient.delete<{ status: string }>("/slack/connection"),
  },
};
