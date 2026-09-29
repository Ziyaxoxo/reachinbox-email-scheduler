"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { api } from "../lib/api/endpoints";
import { ApiException } from "../lib/api/client";
import { useToastStore } from "../store/toastStore";

type Mode = "signin" | "signup";

/**
 * Turns an ApiException into a sentence worth showing a person.
 *
 * The server distinguishes a wrong password from an account that only has
 * Google sign-in, and that distinction is the whole reason the second path
 * exists, so its wording is passed through rather than flattened into
 * "something went wrong".
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiException) {
    if (error.code === "PASSWORD_LOGIN_UNAVAILABLE") return error.message;
    if (error.code === "EMAIL_TAKEN") return error.message;
    if (error.code === "WEAK_PASSWORD") return error.message;
    if (error.code === "NETWORK_ERROR") {
      return "Could not reach the server. Check your connection and try again.";
    }
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function LoginCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSignUp = mode === "signup";

  function switchMode(next: Mode) {
    setMode(next);
    // Cleared rather than carried over: an error about a wrong password is
    // actively misleading once the form has changed underneath it.
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (isSubmitting) return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (isSignUp) {
        await api.auth.register({
          email: trimmedEmail,
          password,
          name: name.trim() || undefined,
        });
        addToast({
          type: "success",
          title: "Account created",
          message: "You are signed in.",
        });
      } else {
        await api.auth.login({ email: trimmedEmail, password });
      }

      // The session cookie is already set by then. Invalidate the cached /me
      // so the app fetches the new identity instead of the 401 that started
      // the visitor on the login page.
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      router.push("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{isSignUp ? "Create account" : "Login"}</h1>

        <a href="/api/v1/auth/google" className="btn-google">
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </a>

        <div className="divider-text">
          <span>or with email</span>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-2.5 text-left">
          {isSignUp ? (
            <div>
              <label className="field-label" htmlFor="login-name">
                Name <span className="text-ink-faint font-normal">(optional)</span>
              </label>
              <input
                id="login-name"
                className="field"
                type="text"
                placeholder="Ada Lovelace"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
          ) : null}

          <div>
            <label className="field-label" htmlFor="login-email">
              Email ID
            </label>
            <input
              id="login-email"
              className={`field ${error ? "field-invalid" : ""}`}
              type="email"
              placeholder="you@example.com"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className={`field ${error ? "field-invalid" : ""}`}
              type="password"
              placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>

          {error ? (
            <p
              id="login-error"
              role="alert"
              className="flex items-start gap-1.5 text-2xs text-danger-600"
            >
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}

          <button className="btn-primary w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {isSignUp ? "Creating account" : "Signing in"}
              </>
            ) : isSignUp ? (
              "Create account"
            ) : (
              "Login"
            )}
          </button>

          <p className="text-2xs text-ink-faint text-center pt-1">
            {isSignUp ? "Already have an account?" : "No account yet?"}{" "}
            <button
              type="button"
              onClick={() => switchMode(isSignUp ? "signin" : "signup")}
              className="text-brand-700 font-medium hover:underline"
              disabled={isSubmitting}
            >
              {isSignUp ? "Sign in" : "Create one"}
            </button>
          </p>
        </form>
      </div>

      <p className="absolute bottom-6 text-2xs text-ink-faint">
        ReachInbox · Secured with Google OAuth 2.0
      </p>
    </div>
  );
}
