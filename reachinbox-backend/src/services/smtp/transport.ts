export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
}

export interface SmtpResult {
  providerId: string;
  accepted: boolean;
}

export type SmtpErrorClassification = "transient" | "permanent" | "ambiguous";

export interface SmtpError {
  code: string;
  message: string;
  classification: SmtpErrorClassification;
}

export interface SmtpTransport {
  send(message: SmtpMessage): Promise<SmtpResult>;
  verify(): Promise<boolean>;
}
