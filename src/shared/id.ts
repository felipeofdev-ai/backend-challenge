import { v7 as uuidv7 } from "uuid";

/** UUID v7 — time-ordered identifiers generated in the application. */
export function newId(): string {
  return uuidv7();
}
