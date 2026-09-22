"use client";
import { useSyncExternalStore } from "react";
import { ru } from "./ru";
export type Locale = "en" | "ru";
let language: Locale = "en",
  initialized = false;
const listeners = new Set<() => void>();
export function translate(text: string, locale: Locale) {
  return locale === "ru" ? (ru[text] ?? text) : text;
}
export function getLocale(): Locale {
  if (!initialized && typeof window !== "undefined") {
    initialized = true;
    try {
      language =
        localStorage.getItem("osiris.locale") === "ru"
          ? "ru"
          : localStorage.getItem("osiris.locale") === "en"
            ? "en"
            : navigator.language.startsWith("ru")
              ? "ru"
              : "en";
    } catch {
      language = "en";
    }
  }
  return language;
}
export function setLocale(locale: Locale) {
  language = locale;
  initialized = true;
  try {
    localStorage.setItem("osiris.locale", locale);
  } catch {
    /* Private storage may be unavailable. */
  }
  document.documentElement.lang = locale;
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function useLocale() {
  const locale = useSyncExternalStore(
    subscribe,
    getLocale,
    () => "en" as Locale,
  );
  return { locale, t: (text: string) => translate(text, locale), setLocale };
}
/** For MapLibre HTML/canvas labels; React components subscribe with useLocale. */
export const t = (text: string) => translate(text, getLocale());
