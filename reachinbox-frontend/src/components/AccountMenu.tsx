"use client";

import { useRouter } from "next/navigation";
import { HelpCircle, LogOut, Settings } from "lucide-react";
import { useAuth } from "../hooks/useAuth";

/**
 * The account menu's contents, shared by the header and the sidebar.
 *
 * Both surfaces open a menu for the same person, and they previously drifted:
 * the sidebar's version grew a Sign out item and nothing else, which is what
 * left Settings and FAQ missing. One component means adding an entry updates
 * both.
 *
 * Renders only the items, so each caller keeps control of its own positioning,
 * dismissal behaviour and shell.
 */
export function AccountMenuItems({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const { logout, isLoggingOut } = useAuth();

  function go(href: string) {
    onNavigate?.();
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        role="menuitem"
        onClick={() => go("/settings")}
        className="account-menu-item"
      >
        <Settings className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />
        Settings
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => go("/faq")}
        className="account-menu-item"
      >
        <HelpCircle className="w-4 h-4 text-ink-faint shrink-0" aria-hidden="true" />
        FAQ
      </button>

      <div className="my-1 border-t border-line" role="separator" />

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onNavigate?.();
          logout();
        }}
        disabled={isLoggingOut}
        className="account-menu-item text-danger-600 hover:bg-danger-50 hover:text-danger-700
                   disabled:opacity-45 disabled:pointer-events-none"
      >
        <LogOut className="w-4 h-4 shrink-0" aria-hidden="true" />
        {isLoggingOut ? "Signing out" : "Sign out"}
      </button>
    </>
  );
}
