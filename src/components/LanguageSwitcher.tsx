"use client";
import { useEffect } from "react";
import { useLocale } from "@/lib/i18n";
export default function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <div
      role="group"
      aria-label="Language / Язык"
      className="flex gap-1 font-mono text-xs"
    >
      <button
        aria-pressed={locale === "ru"}
        onClick={() => setLocale("ru")}
        className={`px-2 py-1 rounded border ${locale === "ru" ? "text-amber-300 border-amber-300" : "border-slate-600"}`}
      >
        RU
      </button>
      <button
        aria-pressed={locale === "en"}
        onClick={() => setLocale("en")}
        className={`px-2 py-1 rounded border ${locale === "en" ? "text-amber-300 border-amber-300" : "border-slate-600"}`}
      >
        EN
      </button>
    </div>
  );
}
