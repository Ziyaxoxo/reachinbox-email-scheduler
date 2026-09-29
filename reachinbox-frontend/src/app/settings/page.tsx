"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, KeyRound, Loader2, User as UserIcon } from "lucide-react";
import { PageShell } from "../../components/PageShell";
import { api } from "../../lib/api/endpoints";
import { ApiException } from "../../lib/api/client";
import { useAuth } from "../../hooks/useAuth";
import { useAuthStore } from "../../store/authStore";
import { useToastStore } from "../../store/toastStore";

const AVATAR_URL_RE = /^https?:\/\/\S+$/i;

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiException) {
    if (
      error.code === "WEAK_PASSWORD" ||
      error.code === "CURRENT_PASSWORD_REQUIRED" ||
      error.code === "PASSWORD_UNCHANGED" ||
      error.code === "INVALID_CREDENTIALS"
    ) {
      return error.message;
    }
    if (error.code === "NETWORK_ERROR") {
      return "Could not reach the server. Check your connection and try again.";
    }
    return error.message;
  }
  return fallback;
}

export default function SettingsPage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const addToast = useToastStore((s) => s.addToast);

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const hasPassword = Boolean(user?.hasPassword);

  // Seed the form once the identity arrives, so the inputs are not blanked and
  // then refilled on every render of the auth query.
  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setAvatar(user.avatar ?? "");
  }, [user]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    if (isSavingProfile) return;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setProfileError("Name cannot be empty");
      return;
    }

    const trimmedAvatar = avatar.trim();
    if (trimmedAvatar && !AVATAR_URL_RE.test(trimmedAvatar)) {
      setProfileError("Avatar must be an http(s) URL");
      return;
    }

    setProfileError(null);
    setProfileSaved(false);
    setIsSavingProfile(true);

    try {
      const updated = await api.auth.updateProfile({
        name: trimmedName,
        avatar: trimmedAvatar || null,
      });

      // The header renders straight from the auth store, so a successful save
      // that did not write the new identity back would look like it did nothing.
      useAuthStore.getState().setUser(updated);

      setProfileSaved(true);
      addToast({ type: "success", title: "Profile updated" });
    } catch (error) {
      setProfileError(message(error, "Could not save your profile"));
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (isSavingPassword) return;

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The two passwords do not match");
      return;
    }

    setPasswordError(null);
    setIsSavingPassword(true);

    try {
      await api.auth.changePassword({
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
      });

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      addToast({
        type: "success",
        title: hasPassword ? "Password changed" : "Password set",
        message: hasPassword
          ? "Use your new password the next time you sign in."
          : "You can now sign in with your email and password.",
      });
    } catch (error) {
      setPasswordError(message(error, "Could not change your password"));
    } finally {
      setIsSavingPassword(false);
    }
  }

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-surface grid place-items-center">
        <span className="text-xs text-ink-faint">Loading…</span>
      </div>
    );
  }

  return (
    <PageShell
      title="Settings"
      description="Manage your profile and the password you sign in with."
    >
      {/* ---------------- Profile ---------------- */}
      <section className="panel p-5 space-y-4">
        <div className="flex items-center gap-2">
          <UserIcon className="w-4 h-4 text-ink-faint" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-ink-900">Profile</h2>
        </div>

        <form onSubmit={saveProfile} className="space-y-3.5">
          <div>
            <label className="field-label" htmlFor="settings-name">
              Display name
            </label>
            <input
              id="settings-name"
              className={`field ${profileError ? "field-invalid" : ""}`}
              type="text"
              value={name}
              maxLength={255}
              onChange={(e) => {
                setName(e.target.value);
                setProfileSaved(false);
              }}
              disabled={isSavingProfile}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="settings-avatar">
              Avatar URL
            </label>
            <input
              id="settings-avatar"
              className={`field ${profileError ? "field-invalid" : ""}`}
              type="url"
              placeholder="https://example.com/me.png"
              value={avatar}
              onChange={(e) => {
                setAvatar(e.target.value);
                setProfileSaved(false);
              }}
              disabled={isSavingProfile}
            />
            <p className="mt-1 text-2xs text-ink-faint">
              Leave empty to fall back to your initials.
            </p>
          </div>

          <div>
            <span className="field-label">Email</span>
            <input
              className="field opacity-60"
              type="email"
              value={user?.email ?? ""}
              readOnly
              disabled
            />
            <p className="mt-1 text-2xs text-ink-faint">
              Your sign-in address is tied to your Google or credential account and
              cannot be edited here.
            </p>
          </div>

          {profileError ? (
            <p role="alert" className="flex items-start gap-1.5 text-2xs text-danger-600">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              <span>{profileError}</span>
            </p>
          ) : null}

          <div className="flex items-center gap-2.5">
            <button className="btn-primary" type="submit" disabled={isSavingProfile}>
              {isSavingProfile ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : null}
              {isSavingProfile ? "Saving" : "Save profile"}
            </button>

            {profileSaved ? (
              <span className="flex items-center gap-1 text-2xs text-brand-700">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                Saved
              </span>
            ) : null}
          </div>
        </form>
      </section>

      {/* ---------------- Password ---------------- */}
      <section className="panel p-5 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-ink-faint" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-ink-900">
            {hasPassword ? "Change password" : "Set a password"}
          </h2>
        </div>

        <p className="text-xs text-ink-muted">
          {hasPassword
            ? "Changing your password does not sign you out of this browser."
            : "You signed in with Google. Set a password to also be able to sign in with your email address."}
        </p>

        <form onSubmit={savePassword} className="space-y-3.5">
          {hasPassword ? (
            <div>
              <label className="field-label" htmlFor="settings-current-password">
                Current password
              </label>
              <input
                id="settings-current-password"
                className={`field ${passwordError ? "field-invalid" : ""}`}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={isSavingPassword}
              />
            </div>
          ) : null}

          <div>
            <label className="field-label" htmlFor="settings-new-password">
              New password
            </label>
            <input
              id="settings-new-password"
              className={`field ${passwordError ? "field-invalid" : ""}`}
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={isSavingPassword}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="settings-confirm-password">
              Confirm new password
            </label>
            <input
              id="settings-confirm-password"
              className={`field ${passwordError ? "field-invalid" : ""}`}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={isSavingPassword}
            />
          </div>

          {passwordError ? (
            <p role="alert" className="flex items-start gap-1.5 text-2xs text-danger-600">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              <span>{passwordError}</span>
            </p>
          ) : null}

          <button className="btn-primary" type="submit" disabled={isSavingPassword}>
            {isSavingPassword ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : null}
            {isSavingPassword
              ? "Saving"
              : hasPassword
                ? "Change password"
                : "Set password"}
          </button>
        </form>
      </section>
    </PageShell>
  );
}
