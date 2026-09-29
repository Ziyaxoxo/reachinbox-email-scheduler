import { ApiException } from "./client";

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiException) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred";
}

export function getErrorDetails(error: unknown): Record<string, string> | undefined {
  if (error instanceof ApiException) {
    return error.details;
  }
  return undefined;
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiException && error.isAuthError;
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiException && error.isNetworkError;
}

export function isRateLimitError(error: unknown): boolean {
  return error instanceof ApiException && error.isRateLimit;
}
