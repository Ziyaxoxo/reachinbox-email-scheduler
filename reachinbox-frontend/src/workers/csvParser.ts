export interface ParsedCsvResult {
  valid: string[];
  invalid: string[];
  duplicates: string[];
  totalRows: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function parseCsvContent(content: string): ParsedCsvResult {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const line of lines) {
    // Handle CSV with possible commas, quotes
    const emails = line.split(/[,;\t]/).map((e) => e.trim().replace(/^["']|["']$/g, ""));

    for (const email of emails) {
      if (!email) continue;

      const normalized = normalizeEmail(email);

      if (!isValidEmail(normalized)) {
        invalid.push(email);
        continue;
      }

      if (seen.has(normalized)) {
        duplicates.push(normalized);
        continue;
      }

      seen.add(normalized);
      valid.push(normalized);
    }
  }

  return {
    valid,
    invalid,
    duplicates,
    totalRows: lines.length,
  };
}

// Web Worker message handler (only in worker context)
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (event: MessageEvent) => {
    const { content, id } = event.data as { content: string; id: string };

    try {
      const result = parseCsvContent(content);
      self.postMessage({ id, success: true, result });
    } catch (error) {
      self.postMessage({
        id,
        success: false,
        error: error instanceof Error ? error.message : "Failed to parse CSV",
      });
    }
  };
}
