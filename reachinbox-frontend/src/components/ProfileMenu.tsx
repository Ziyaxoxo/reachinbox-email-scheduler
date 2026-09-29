"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { AccountMenuItems } from "./AccountMenu";

/**
 * Account menu behind the avatar in the top bar.
 *
 * Closes on Escape, on outside click, and after any navigation. A menu that
 * stays open behind a route change looks broken even though it is behaving
 * correctly, and Escape is the only dismissal a keyboard user reliably knows to
 * try.
 */
export function ProfileMenu() {
  const { user, logout, isLoggingOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  if (!user) return null;

  const initial = user.name.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Account menu"
        className="flex items-center gap-2.5 h-9 pl-1 pr-2 rounded-ctl border border-transparent
                   hover:border-line hover:bg-surface-muted transition-colors"
      >
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
            {initial}
          </div>
        )}

        <div className="hidden sm:block text-left leading-tight">
          <p className="text-xs font-medium text-ink-900">{user.name}</p>
          <p className="text-2xs text-ink-faint max-w-[160px] truncate">{user.email}</p>
        </div>

        <ChevronDown
          className={`w-3.5 h-3.5 text-ink-faint transition-transform ${isOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-[232px] bg-surface
                     border border-line rounded-card shadow-lg py-1.5 animate-fade-in"
        >
          <div className="px-3 py-2 border-b border-line mb-1">
            <p className="text-xs font-medium text-ink-900 truncate">{user.name}</p>
            <p className="text-2xs text-ink-faint truncate">{user.email}</p>
          </div>

          <AccountMenuItems onNavigate={() => setIsOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
