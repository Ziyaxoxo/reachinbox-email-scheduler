"use client";

import { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { LoginCard } from "./LoginCard";
import { ToastContainer } from "./Toast";
import { useAuth } from "../hooks/useAuth";

/**
 * Shell for pages that are not the mailbox: Header, Sidebar and a content
 * column, without the schedule search bar and tab switcher.
 *
 * The auth guard is here rather than in each page so a new route cannot
 * accidentally render account data to a signed-out visitor.
 */
export function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

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

  return (
    <div className="app-shell">
      <Header />

      <div className="app-body">
        <Sidebar activeTab={undefined} onCompose={() => router.push("/compose")} />

        <div className="app-main">
          <main className="app-content">
            <div className="content-frame max-w-[720px] space-y-4">
              <div>
                <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
                {description ? (
                  <p className="text-xs text-ink-muted mt-1">{description}</p>
                ) : null}
              </div>

              {children}
            </div>
          </main>
        </div>
      </div>

      <ToastContainer />
    </div>
  );
}
