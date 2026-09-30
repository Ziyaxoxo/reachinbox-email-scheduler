"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Search, SlidersHorizontal, RefreshCw, PenLine, X, Check } from "lucide-react";
import { clsx } from "clsx";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { ScheduledList } from "./ScheduledList";
import { SentList } from "./SentList";
import { ComposeModal } from "./ComposeModal";
import { SlackConnect } from "./SlackConnect";
import { ToastContainer } from "./Toast";
import { useAuth } from "../hooks/useAuth";
import { LoginCard } from "./LoginCard";

type Tab = "scheduled" | "sent";

/** Empty value means "no status filter". */
const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "queued", label: "Queued" },
  { value: "sending", label: "Sending" },
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export function Dashboard() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  /**
   * The tab is derived from the route, with local state only as a fallback for
   * unrouted views (/, /compose).
   *
   * Holding the tab purely as local state was the bug: the sidebar pushed
   * /sent but the Dashboard kept rendering the Scheduled list, so the Sent
   * navigation appeared dead.
   */
  const routeTab: Tab | null = pathname.startsWith("/sent")
    ? "sent"
    : pathname.startsWith("/scheduled")
      ? "scheduled"
      : null;

  const [localTab, setLocalTab] = useState<Tab>("scheduled");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const activeTab = routeTab ?? localTab;

  const selectTab = (tab: Tab) => {
    setLocalTab(tab);
    router.push(tab === "sent" ? "/sent" : "/scheduled");
  };

  // Close the filter popover on outside click, matching SchedulePicker.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  /**
   * Compose is driven by the route so a refresh or a direct visit to
   * /compose still shows the editor. Routing *and* holding local state was the
   * bug: pushing the route remounted this component and reset the flag, so the
   * editor closed the instant it opened.
   */
  const isComposeOpen = pathname === "/compose";

  // Both are stable identities so that consumers can list them as dependencies.
  // A new function every render would silently defeat ComposeModal's
  // useCallback memoisation, since router itself never changes.
  const openCompose = useCallback(() => router.push("/compose"), [router]);
  const closeCompose = useCallback(() => router.push("/"), [router]);

  const visibleQuery = useMemo(() => query.trim().toLowerCase(), [query]);

  /** Drop cached list pages so the current view is refetched. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["schedules"] });
    void queryClient.invalidateQueries({ queryKey: ["emails"] });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface grid place-items-center">
        <span className="text-xs text-ink-faint">Loading…</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginCard />;
  }

  const activeStatusLabel =
    STATUS_OPTIONS.find((o) => o.value === status)?.label ?? "All statuses";

  return (
    <div className="app-shell">
      <Header />

      <div className="app-body">
        <Sidebar onCompose={openCompose} activeTab={activeTab} />

        <div className="app-main">
          <div className="searchbar px-4 sm:px-5 h-[52px] border-b border-line bg-surface">
            <div className="search-field">
              <Search className="w-4 h-4" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search emails"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="icon-btn shrink-0"
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="relative" ref={filterRef}>
              <button
                type="button"
                className={clsx("icon-btn", status && "icon-btn-active")}
                aria-label={`Filter by status, currently ${activeStatusLabel}`}
                aria-expanded={filterOpen}
                title={`Filter: ${activeStatusLabel}`}
                onClick={() => setFilterOpen((v) => !v)}
              >
                <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
              </button>

              {filterOpen ? (
                <div
                  className="popover"
                  role="menu"
                  aria-label="Filter by status"
                >
                  <p className="field-label">Status</p>
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value || "all"}
                      type="button"
                      role="menuitemradio"
                      aria-checked={status === option.value}
                      onClick={() => {
                        setStatus(option.value);
                        setFilterOpen(false);
                      }}
                      className="popover-option flex w-full items-center justify-between gap-2"
                    >
                      {option.label}
                      {status === option.value ? (
                        <Check className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="icon-btn"
              onClick={refresh}
              aria-label="Refresh list"
              title="Refresh list"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
            </button>

            <div className="ml-auto flex items-center gap-2">
              <div
                className="hidden sm:flex items-center gap-0.5 p-0.5 rounded-ctl bg-surface-input border border-line"
                role="tablist"
                aria-label="Mailbox view"
              >
                {(["scheduled", "sent"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === key}
                    onClick={() => selectTab(key)}
                    className={clsx(
                      "h-7 px-3 rounded-[6px] text-xs font-medium capitalize transition-colors",
                      activeTab === key
                        ? "bg-surface text-ink shadow-card"
                        : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {key}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={openCompose}
                className="btn-primary btn-sm"
              >
                <PenLine className="w-3.5 h-3.5" aria-hidden="true" />
                Compose
              </button>
            </div>
          </div>

          <main className="app-content">
            <div className="content-frame space-y-4">
              <SlackConnect />

              {activeTab === "scheduled" ? (
                <ScheduledList filter={visibleQuery} status={status} />
              ) : (
                <SentList filter={visibleQuery} status={status} />
              )}
            </div>
          </main>
        </div>
      </div>

      <ComposeModal isOpen={isComposeOpen} onClose={closeCompose} />
      <ToastContainer />
    </div>
  );
}
