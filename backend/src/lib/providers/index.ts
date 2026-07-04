import aisensy from "./aisensy";
import wati from "./wati";
import { Provider } from "./types";

export function getProvider(name?: string): Provider | null {
  if (name === "aisensy") return aisensy;
  if (name === "wati") return wati;
  return null; // "meta" (or unset) uses the existing Meta code paths directly
}

export * from "./types";
