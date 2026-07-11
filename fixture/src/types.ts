export type EventStatus = "received" | "forwarded" | "failed" | "discarded";

export interface WebhookEvent {
  id: string;
  endpoint: string;
  status: EventStatus;
  description: string;
  payloadBytes: number;
  /** ISO-8601 arrival timestamp. */
  receivedAt: string;
}

export interface Endpoint {
  slug: string;
  url: string;
  secret: string;
  active: boolean;
}

export interface Profile {
  displayName: string;
  email: string;
  timezone: string;
  digestEnabled: boolean;
  updatedAt: number;
}

export interface DeliveryAttempt {
  eventId: string;
  attempt: number;
  ok: boolean;
  at: string;
}
