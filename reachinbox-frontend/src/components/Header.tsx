"use client";

import { Mail, LogOut, ChevronDown } from "lucide-react";
import { useAuth } from "../hooks/useAuth";

export function Header() {
  const { user, logout, isLoggingOut } = useAuth();

  return (
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true">
        <Mail className="w-[15px] h-[15px]" strokeWidth={2.2} />
      </div>
      <span className="brand-word">ReachInbox</span>

      <div className="topbar-divider ml-1" aria-hidden="true" />

      <span className="text-xs text-ink-faint truncate">Email Scheduler</span>

      {user ? (
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2.5 pr-1">
            {user.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatar}
                alt=""
                className="w-7 h-7 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-800 grid place-items-center text-xs font-semibold">
                {user.name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="text-right leading-tight">
              <p className="text-xs font-medium text-ink-900">{user.name}</p>
              <p className="text-2xs text-ink-faint">{user.email}</p>
            </div>
          </div>

          <button
            onClick={() => logout()}
            disabled={isLoggingOut}
            className="icon-btn"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </header>
  );
}
