export interface EvidenceInputs {
  records_used: number;
  records_excluded: number;
  excluded_reasons: Record<string, number>;
}

/** A derived number plus everything needed to audit it. */
export interface EvidencedMetric {
  value: number | null;
  unit: string;
  method: string;
  method_version: string;
  window: { start: string; end: string } | null;
  inputs: EvidenceInputs;
  source: "whoop" | "manual" | "mixed";
  status: "available" | "insufficient_data" | "unconfirmed" | "fetch_failed";
  limitations: string[];
}
