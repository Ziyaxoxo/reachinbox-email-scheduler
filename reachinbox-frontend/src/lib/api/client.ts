import { v4 as uuidv4 } from "uuid";
import type { ApiError } from "./types";

const BASE_URL = "/api/v1";

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const correlationId = uuidv4();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
      ...((options.headers as Record<string, string>) || {}),
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as ApiError;
        throw new ApiException(
          response.status,
          errorData.error?.code || "UNKNOWN_ERROR",
          errorData.error?.message || `Request failed with status ${response.status}`,
          errorData.error?.details,
          correlationId,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }

      if (error instanceof TypeError && error.message === "Failed to fetch") {
        throw new ApiException(
          0,
          "NETWORK_ERROR",
          "Network error. Please check your connection.",
          undefined,
          correlationId,
        );
      }

      throw new ApiException(
        0,
        "UNKNOWN_ERROR",
        error instanceof Error ? error.message : "An unexpected error occurred",
        undefined,
        correlationId,
      );
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "GET" });
  }

  /**
   * POST with an optional caller-supplied idempotency key.
   *
   * The key must be stable across retries of the same logical request. When
   * omitted a fresh UUID is generated, which is correct for reads-like
   * mutations but NOT safe for retries of a create — callers that retry should
   * pass their own key.
   */
  async post<T>(
    endpoint: string,
    body: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const key = options.idempotencyKey ?? uuidv4();

    return this.request<T>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": key },
    });
  }

  async put<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "DELETE" });
  }
}

export class ApiException extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiException";
  }

  get isAuthError(): boolean {
    return this.statusCode === 401;
  }

  get isForbidden(): boolean {
    return this.statusCode === 403;
  }

  get isNotFound(): boolean {
    return this.statusCode === 404;
  }

  get isConflict(): boolean {
    return this.statusCode === 409;
  }

  get isRateLimit(): boolean {
    return this.statusCode === 429;
  }

  get isServerError(): boolean {
    return this.statusCode >= 500;
  }

  get isNetworkError(): boolean {
    return this.statusCode === 0;
  }
}

export const apiClient = new ApiClient(BASE_URL);
