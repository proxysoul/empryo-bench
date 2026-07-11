/**
 * Event ids. Since the 0.4 storage rework these are random — collision
 * resistance is all we need now that ordering lives on the timestamp column.
 */
export function newEventId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
