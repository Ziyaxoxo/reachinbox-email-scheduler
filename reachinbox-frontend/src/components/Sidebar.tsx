"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { PenLine, Calendar, Send, ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import { useAuth } from "../hooks/useAuth";
import { AccountMenuItems } from "./AccountMenu";

export function Sidebar({
  onCompose,
  scheduledCount,
  sentCount,
  activeTab,
}: {
  onCompose?: () => void;
  scheduledCount?: number;
  sentCount?: number;
  activeTab?: "scheduled" | "sent";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const items = [
    {
      key: "scheduled",
      href: "/scheduled",
      label: "Scheduled",
      icon: Calendar,
      count: scheduledCount,
    },
    { key: "sent", href: "/sent", label: "Sent", icon: Send, count: sentCount },
  ];

  // Prefer the in-app tab selection; fall back to the route on direct
  // navigation / refresh so a deep link still highlights correctly.
  const routeKey = items.find((i) => pathname.startsWith(i.href))?.key;
  const activeKey = activeTab ?? routeKey;

  return (
    <nav className="sidebar" aria-label="Mailbox">
      <div className="sidebar-head">
        {user ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              className="profile"
            >
              <span className="profile-avatar">
                {user.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatar}
                    alt=""
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  user.name.charAt(0).toUpperCase()
                )}
              </span>
              <span className="min-w-0 flex-1 max-lg:hidden">
                <span className="profile-name block">{user.name}</span>
                <span className="profile-email block">{user.email}</span>
              </span>
              <ChevronDown
                className="w-3.5 h-3.5 text-ink-faint shrink-0 max-lg:hidden"
                aria-hidden="true"
              />
            </button>

            {menuOpen ? (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div
                  role="menu"
                  aria-label="Account"
                  className="absolute z-20 left-0 right-0 top-full mt-1 bg-surface border border-line rounded-ctl shadow-pop p-1 animate-fade-in"
                >
                  {/*
                    Shared with the header's account menu so the two cannot
                    drift apart. This one previously offered Sign out only.
                  */}
                  <AccountMenuItems onNavigate={() => setMenuOpen(false)} />
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            onCompose?.();
            router.push("/compose");
          }}
          className="sidebar-cta mt-3 flex items-center justify-center gap-1.5"
        >
          <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
          Compose
        </button>
      </div>

      <p className="nav-group-label">Inbox</p>

      <ul className="px-3 pb-4 space-y-0.5 max-lg:px-2">
        {items.map((item) => {
          const isActive = activeKey === item.key;
          const Icon = item.icon;

          return (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => router.push(item.href)}
                aria-current={isActive ? "page" : undefined}
                className={clsx("nav-item", isActive && "nav-item-active")}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
                {typeof item.count === "number" ? (
                  <span
                    className={clsx(
                      "nav-count",
                      isActive && "nav-count-active",
                    )}
                  >
                    {item.count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto px-3 pb-4 max-lg:px-2">
        <div className="rounded-ctl border border-line bg-surface-muted p-3 max-lg:hidden">
          <p className="text-2xs text-ink-faint leading-relaxed">
            Scheduled sends are rate-limited per sender and rescheduled automatically when a
            window is full.
          </p>
        </div>
      </div>
    </nav>
  );
}
