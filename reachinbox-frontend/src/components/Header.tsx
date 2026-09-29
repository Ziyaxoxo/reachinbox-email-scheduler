"use client";

import { Mail } from "lucide-react";
import { ProfileMenu } from "./ProfileMenu";
import { useAuth } from "../hooks/useAuth";

export function Header() {
  const { user } = useAuth();

  return (
    <header className="topbar">
      <div className="brand-mark" aria-hidden="true">
        <Mail className="w-[15px] h-[15px]" strokeWidth={2.2} />
      </div>
      <span className="brand-word">ReachInbox</span>

      <div className="topbar-divider ml-1" aria-hidden="true" />

      <span className="text-xs text-ink-faint truncate">Email Scheduler</span>

      {/*
        The avatar is now the account menu trigger, replacing a separate
        sign-out icon button. It stays keyboard- and screen-reader-operable as a
        real button with aria-expanded rather than a clickable div.
      */}
      {user ? (
        <div className="ml-auto flex items-center gap-2">
          <ProfileMenu />
        </div>
      ) : null}
    </header>
  );
}
