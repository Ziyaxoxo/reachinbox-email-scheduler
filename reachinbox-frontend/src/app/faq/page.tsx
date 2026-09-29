"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { PageShell } from "../../components/PageShell";

interface Entry {
  question: string;
  answer: string;
}

const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: "Scheduling",
    entries: [
      {
        question: "How do I schedule an email?",
        answer:
          "Click Compose, add recipients (paste addresses one per line, or upload a CSV), write your subject and body, then pick a date and time. The schedule appears under Scheduled with status queued. At the scheduled moment a worker picks it up, it moves to sending, and then to sent once delivery is confirmed.",
      },
      {
        question: "What do the status colours mean?",
        answer:
          "Queued means the send is waiting for its time. Sending means a worker has claimed it and is delivering it right now. Sent means every recipient was accepted. Failed means delivery was attempted and rejected, and the reason is shown on the row.",
      },
      {
        question: "Can I schedule in the past?",
        answer:
          "No. A time in the past is rejected, because it would otherwise send immediately and make the scheduling guarantee meaningless.",
      },
      {
        question: "What happens if the server restarts before a send?",
        answer:
          "Nothing is lost. Pending work is recorded in the database, not only in memory, and the service reconciles outstanding schedules on boot and then every minute. A schedule that came due while the server was down is sent as soon as it is back up.",
      },
    ],
  },
  {
    title: "Recipients and limits",
    entries: [
      {
        question: "Is there a limit on how many recipients one send can have?",
        answer:
          "Yes. The default is 1000 recipients per schedule. Beyond that, split the campaign into more than one schedule.",
      },
      {
        question: "What is per-sender rate limiting?",
        answer:
          "Each sender has an hourly send budget. When the budget is used up, further sends are not dropped: they are deferred and retried in the next window. This is what protects a sending domain from being flagged by a provider.",
      },
      {
        question: "Why are sends staggered instead of all at once?",
        answer:
          "A campaign can set a delay between recipients. Sends are then spread out over that interval rather than hitting the provider in one burst, which is both gentler on your sending reputation and closer to how a person would actually write to a list.",
      },
      {
        question: "Can I import recipients from a CSV?",
        answer:
          "Yes. In the compose window, drop a CSV into the recipient area. Addresses are normalised and de-duplicated as they are read.",
      },
    ],
  },
  {
    title: "Account",
    entries: [
      {
        question: "How do I sign in?",
        answer:
          "Either continue with Google, or use your email address and password. The two work on the same account: if you signed in with Google first, you can set a password under Settings and then use either method from then on.",
      },
      {
        question: "I signed in with Google. How do I get a password?",
        answer:
          "Open the account menu, choose Settings, and use Set a password. Your existing session already proves who you are, so no current password is needed for that first one.",
      },
      {
        question: "Where do I change my password?",
        answer:
          "Account menu, then Settings, then Change password. You need your current password to set a new one, which stops anyone who finds a logged-in browser from locking you out.",
      },
      {
        question: "Can I change my email address?",
        answer:
          "Not in the app. The address is tied to the account you signed up with, so it has to stay stable for delivery and for signing in.",
      },
      {
        question: "How do I sign out?",
        answer:
          "Account menu, then Sign out. That clears the session cookie in this browser. Because the session cookie is HttpOnly, signing out on a shared computer really does end the session.",
      },
    ],
  },
  {
    title: "Mail and search",
    entries: [
      {
        question: "What shows up in the Sent tab?",
        answer:
          "One row per recipient, with the address and the delivery time, rather than one row per campaign. That is the level at which delivery actually succeeds or fails.",
      },
      {
        question: "How does search work?",
        answer:
          "Typing in the search box filters your schedules and sent records by recipient, subject and status. The status filter next to it narrows the same list to one state.",
      },
      {
        question: "Why might search return an error?",
        answer:
          "Full-text search is backed by a separate index that is not part of this deployment, so the search endpoint reports that it is unavailable. List and filter views are unaffected and read straight from the database.",
      },
      {
        question: "Does the app send real email?",
        answer:
          "It goes through a configured SMTP transport. In a demo environment that is a test transport, so messages are accepted and recorded exactly as they would be in production without reaching anyone's inbox.",
      },
    ],
  },
];

function FaqEntry({ entry }: { entry: Entry }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between gap-3 py-3 text-left
                   text-[13px] font-medium text-ink-900 hover:text-brand-800 transition-colors"
      >
        <span>{entry.question}</span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-ink-faint transition-transform ${isOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <p className="pb-3.5 pr-8 text-xs text-ink-muted leading-relaxed animate-fade-in">
          {entry.answer}
        </p>
      ) : null}
    </div>
  );
}

export default function FaqPage() {
  return (
    <PageShell
      title="FAQ"
      description="Answers to the questions that come up most often about scheduling, limits and your account."
    >
      {SECTIONS.map((section) => (
        <section key={section.title} className="panel p-5">
          <h2 className="text-sm font-semibold text-ink-900 mb-1">{section.title}</h2>
          <div>
            {section.entries.map((entry) => (
              <FaqEntry key={entry.question} entry={entry} />
            ))}
          </div>
        </section>
      ))}
    </PageShell>
  );
}
