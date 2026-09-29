export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "AUTHENTICATION_ERROR", message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Access denied") {
    super(403, "AUTHORIZATION_ERROR", message);
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

export class IdempotencyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "IDEMPOTENCY_CONFLICT", message, details);
    this.name = "IdempotencyError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Rate limit exceeded", details?: Record<string, unknown>) {
    super(429, "RATE_LIMIT_EXCEEDED", message, details);
    this.name = "RateLimitError";
  }
}

export class DependencyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(502, "DEPENDENCY_ERROR", message, details);
    this.name = "DependencyError";
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error") {
    super(500, "INTERNAL_ERROR", message);
    this.name = "InternalError";
  }
}
