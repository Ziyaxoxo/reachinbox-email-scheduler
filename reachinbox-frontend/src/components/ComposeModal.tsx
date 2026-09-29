"use client";

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  X,
  ArrowLeft,
  Upload,
  AlertCircle,
  CheckCircle2,
  Trash2,
  FileText,
  Clock,
} from "lucide-react";
import { clsx } from "clsx";
import { v4 as uuidv4 } from "uuid";
import { useSchedules } from "../hooks/useSchedules";
import { SchedulePicker } from "./SchedulePicker";
import { RichTextEditor } from "./RichTextEditor";
import { parseCsvContent } from "../workers/csvParser";
import { sanitizeEmailHtml } from "../lib/sanitize";

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ParsedRecipients {
  valid: string[];
  invalid: string[];
  duplicates: string[];
  totalRows: number;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function initials(email: string) {
  const name = email.split("@")[0] ?? email;
  return name.slice(0, 2).toUpperCase();
}

/**
 * Default send time.
 *
 * Defaults to "now" made the form permanently invalid: the validation rule is
 * `startTime > Date.now()`, so the pristine state could never pass and every
 * first attempt failed. One hour out is unambiguously schedulable.
 */
function defaultSendTime(): Date {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setSeconds(0, 0);
  return next;
}

/** Matches the backend's z.string().email() closely enough for inline feedback. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 320;

export function ComposeModal({ isOpen, onClose }: ComposeModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [startTime, setStartTime] = useState(defaultSendTime);
  const [delayMs, setDelayMs] = useState(0);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [parsed, setParsed] = useState<ParsedRecipients | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * In-progress address typed into the To field.
   *
   * Held separately from `recipients` so a half-typed address is never sent to
   * the backend, and so pressing Enter commits it deliberately.
   */
  const [draftRecipient, setDraftRecipient] = useState("");
  const [recipientError, setRecipientError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Stable per-attempt idempotency key. Held in a ref so a network retry or a
   * second click reuses the same key and the backend replays the original
   * schedule. Regenerated only after a confirmed success or an explicit
   * discard, so it can never be reused for a genuinely new schedule.
   */
  const idempotencyKey = useRef(uuidv4());

  const { createSchedule, isCreating } = useSchedules();

  useEffect(() => {
    if (isOpen) idempotencyKey.current = uuidv4();
  }, [isOpen]);

  const validate = useCallback((): boolean => {
    const next: Record<string, string> = {};

    if (!subject.trim()) next.subject = "Add a subject";
    if (!body.trim() || body === "<br>") next.body = "Write a message body";
    if (recipients.length === 0) next.recipients = "Upload a recipient list";
    if (startTime.getTime() <= Date.now()) {
      next.startTime = "Pick a future time";
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) next.delayMs = "Must be 0 or more";
    if (hourlyLimit < 1 || hourlyLimit > 10000) {
      next.hourlyLimit = "Between 1 and 10,000";
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }, [subject, body, recipients, startTime, delayMs, hourlyLimit]);

  const handleFile = useCallback((file: File) => {
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setErrors((p) => ({ ...p, recipients: "Only .csv and .txt files are supported" }));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setErrors((p) => ({ ...p, recipients: "File must be smaller than 5 MB" }));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseCsvContent(String(e.target?.result ?? ""));
      setParsed(result);
      setRecipients(result.valid);
      setErrors((p) => {
        const { recipients: _drop, ...rest } = p;
        return rest;
      });
    };
    reader.onerror = () => {
      setErrors((p) => ({ ...p, recipients: "Could not read that file" }));
    };
    reader.readAsText(file);
  }, []);

  const removeRecipient = useCallback((email: string) => {
    setRecipients((prev) => prev.filter((e) => e !== email));
  }, []);

  /**
   * Commit a typed address into the list, or explain why it was refused.
   *
   * Previously the To field was `readOnly`, so a typed address simply
   * vanished — the most likely reason scheduling appeared broken.
   */
  const addRecipient = useCallback(
    (raw: string) => {
      const value = raw.trim().replace(/[,;]+$/, "");
      if (!value) {
        setRecipientError("");
        return;
      }
      if (!EMAIL_RE.test(value) || value.length > MAX_EMAIL_LEN) {
        setRecipientError(`"${value}" isn't a valid email address`);
        return;
      }
      if (recipients.includes(value)) {
        setRecipientError(`${value} is already on the list`);
        return;
      }
      setRecipientError("");
      setRecipients((prev) => [...prev, value]);
      // Clears the stale "upload a recipient list" error from a previous attempt.
      setErrors((prev) => {
        const { recipients: _drop, ...rest } = prev;
        return rest;
      });
    },
    [recipients],
  );

  /** Enter, comma or space commit the address being typed. */
  const onRecipientKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === "," || e.key === ";") {
        e.preventDefault();
        addRecipient(draftRecipient);
        setDraftRecipient("");
      } else if (
        e.key === "Backspace" &&
        draftRecipient === "" &&
        recipients.length > 0
      ) {
        // Backspace on an empty field removes the last address, like a token field.
        removeRecipient(recipients[recipients.length - 1]!);
      }
    },
    [addRecipient, draftRecipient, recipients, removeRecipient],
  );

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    try {
      await createSchedule({
        subject,
        // Sanitized before it leaves the browser; the backend re-validates.
        body: sanitizeEmailHtml(body),
        recipients,
        startAt: startTime.toISOString(),
        delayMs,
        hourlyLimit,
        idempotencyKey: idempotencyKey.current,
      });

      reset();
      onClose();
    } catch {
      // Form state and the idempotency key are preserved so the user can
      // safely retry the same logical request.
    }
  }, [
    validate,
    createSchedule,
    subject,
    body,
    recipients,
    startTime,
    delayMs,
    hourlyLimit,
  ]);

  function reset() {
    setSubject("");
    setBody("");
    setRecipients([]);
    setStartTime(defaultSendTime());
    setDelayMs(0);
    setHourlyLimit(100);
    setErrors({});
    setParsed(null);
    setDraftRecipient("");
    setRecipientError("");
    idempotencyKey.current = uuidv4();
  }

  if (!isOpen) return null;

  const visibleRecipients = recipients.slice(0, 4);
  const overflow = recipients.length - visibleRecipients.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface animate-fade-in">
      <div className="compose-head">
        <button
          type="button"
          onClick={onClose}
          className="icon-btn border-transparent"
          aria-label="Back to dashboard"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        <h2 className="compose-title">Compose New Email</h2>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            <SchedulePicker value={startTime} onChange={setStartTime} minDate={new Date()} />
            {/* Shown beside the control that caused it, not only in the
                dropzone far below where the user is looking. */}
            {errors.startTime ? (
              <p className="field-error m-0 text-right" role="alert">
                {errors.startTime}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isCreating}
            className="btn-brand-outline btn-sm"
          >
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            {isCreating ? "Scheduling…" : "Send Later"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn border-transparent"
            aria-label="Close compose"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="compose-body">
        <div className="compose-inner space-y-3.5">
          <div className="flex items-start gap-3">
            <span className="compose-label">From</span>
            <div className="compose-field">
              <span className="token">
                <span className="token-avatar">ME</span>
                ReachInbox
              </span>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <span className="compose-label">To</span>
            <div className="compose-field">
              <div className="flex flex-wrap items-center gap-1.5">
                {visibleRecipients.map((email) => (
                  <span key={email} className="token">
                    <span className="token-avatar">{initials(email)}</span>
                    {email}
                    <button
                      type="button"
                      onClick={() => removeRecipient(email)}
                      className="ml-0.5 text-brand-700 hover:text-brand-900"
                      aria-label={`Remove ${email}`}
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {overflow > 0 ? <span className="token">+{overflow}</span> : null}

                <input
                  className={clsx(
                    "field",
                    (errors.recipients || recipientError) && "field-invalid",
                  )}
                  placeholder={
                    recipients.length > 0 ? "Add another…" : "recipient@example.com"
                  }
                  aria-label="Recipients"
                  aria-invalid={Boolean(errors.recipients || recipientError)}
                  aria-describedby="recipients-error"
                  value={draftRecipient}
                  onChange={(e) => {
                    setDraftRecipient(e.target.value);
                    if (recipientError) setRecipientError("");
                  }}
                  onKeyDown={onRecipientKeyDown}
                  onBlur={() => {
                    if (draftRecipient.trim()) {
                      addRecipient(draftRecipient);
                      setDraftRecipient("");
                    }
                  }}
                />
              </div>

              {recipientError || errors.recipients ? (
                <p id="recipients-error" className="field-error" role="alert">
                  {recipientError || errors.recipients}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="btn-ghost btn-sm shrink-0"
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              Upload List
            </button>
          </div>

          <div className="flex items-start gap-3">
            <span className="compose-label">Subject</span>
            <div className="compose-field">
              <input
                className={clsx("field", errors.subject && "field-invalid")}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                maxLength={500}
                aria-label="Subject"
              />
              {errors.subject ? <p className="field-error">{errors.subject}</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-[98px]">
            <div className="flex items-center gap-2">
              <label className="compose-label-inline" htmlFor="delay">
                Delay between 2 emails
              </label>
              <input
                id="delay"
                type="number"
                value={delayMs}
                onChange={(e) => setDelayMs(Number(e.target.value))}
                min={0}
                max={86400000}
                className={clsx("field field-sm w-[74px]", errors.delayMs && "field-invalid")}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="compose-label-inline" htmlFor="hourly">
                Hourly Limit
              </label>
              <input
                id="hourly"
                type="number"
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(Number(e.target.value))}
                min={1}
                max={10000}
                className={clsx(
                  "field field-sm w-[74px]",
                  errors.hourlyLimit && "field-invalid",
                )}
              />
            </div>
          </div>

          <div className="pt-1">
            <RichTextEditor value={body} onChange={setBody} minHeight={260} />
            {errors.body ? <p className="field-error">{errors.body}</p> : null}
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            className={clsx("dropzone", dragging && "dropzone-active")}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="sr-only"
              aria-label="Upload recipient file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />

            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-ink-muted">
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                Drop a .csv or .txt list, or{" "}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="text-brand-700 font-medium hover:underline"
                >
                  browse
                </button>
              </span>

              {parsed ? (
                <>
                  <span className="inline-flex items-center gap-1 text-brand-700">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    {parsed.valid.length} valid
                  </span>
                  {parsed.invalid.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-danger-500">
                      <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                      {parsed.invalid.length} invalid
                    </span>
                  ) : null}
                  {parsed.duplicates.length > 0 ? (
                    <span className="inline-flex items-center gap-1 text-ink-faint">
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      {parsed.duplicates.length} duplicates removed
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>

            {errors.startTime ? (
              <p className="field-error text-center mt-2">{errors.startTime}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 sm:px-8 h-14 border-t border-line bg-surface">
        <button type="button" onClick={reset} className="btn-ghost btn-sm">
          Discard
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isCreating}
          className="btn-primary btn-sm"
        >
          {isCreating ? "Scheduling…" : "Schedule Email"}
        </button>
      </div>
    </div>
  );
}
