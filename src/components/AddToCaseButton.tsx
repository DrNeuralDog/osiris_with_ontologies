"use client";
import { requestAddToCase, type CaseReference } from "@/lib/cases";
import { useLocale } from "@/lib/i18n";
import type { InvestigationSeed } from "@/lib/ontology";
export default function AddToCaseButton({
  reference,
  seed,
  analysis,
}: {
  reference?: CaseReference;
  seed?: InvestigationSeed;
  analysis?: {
    kind: "cluster" | "acoustic";
    parameters: Record<string, unknown>;
    cluster_id?: string;
  };
}) {
  const { t } = useLocale();
  return (
    <button
      className="rounded border border-amber-400/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-400/10"
      onClick={() => {
        if (reference) requestAddToCase(reference);
        else if (seed) requestAddToCase({ seed });
        else if (analysis) requestAddToCase({ analysis });
      }}
    >
      {t("ADD TO CASE")}
    </button>
  );
}
