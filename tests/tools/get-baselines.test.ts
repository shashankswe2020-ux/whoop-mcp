import { describe, it, expect } from "vitest";
import { getBaselines } from "../../src/tools/get-baselines.js";
import { analyticsClient, ANALYTICS_NOW, recoveryFixture } from "../helpers/analytics-fixtures.js";

describe("getBaselines", () => {
  it("excludes latest and current day, uses midrank ties and flags constant baselines", async () => {
    const result = await getBaselines(analyticsClient(), {}, ANALYTICS_NOW);
    expect(result.metrics.hrv).toMatchObject({
      mean: 40,
      latest: 100,
      latest_percentile: 100,
      sample_size: 19,
      constant_baseline: true,
    });
    expect(result.metrics.rhr?.latest_percentile).toBe(50);
    expect(result.data_quality.sources.recovery?.cache_status).toBe("unknown");
    expect(result.disclaimer).toContain("not medical advice");
  });
  it("returns null bands below 14 historical points", async () => {
    const result = await getBaselines(analyticsClient(14), {}, ANALYTICS_NOW);
    expect(result.metrics.hrv).toBeNull();
    expect(result.metric_status.hrv).toMatchObject({
      sample_size: 13,
      status: "insufficient_data",
    });
  });
  it("excludes calibration and missing cycle context without affecting sleep", async () => {
    const records = Array.from({ length: 20 }, (_, index) => recoveryFixture(index));
    records[1]!.score!.user_calibrating = true;
    const result = await getBaselines(
      analyticsClient(20, { "/v2/recovery": { records }, "/v2/cycle": { records: [] } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metrics.hrv).toBeNull();
    expect(result.metrics.sleep_hours?.mean).toBe(7);
    expect(result.data_quality.sources.recovery?.exclusions.calibrating).toBe(1);
    expect(result.data_quality.sources.recovery?.exclusions.missing_join).toBe(19);
  });
  it("retains sleep baselines when recovery fetching fails", async () => {
    const result = await getBaselines(
      analyticsClient(20, { "/v2/recovery": new Error("secret") }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metrics.hrv).toBeNull();
    expect(result.metrics.sleep_hours).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("rejects out-of-range inputs", async () => {
    await expect(
      getBaselines(analyticsClient(), { baseline_days: 181 }, ANALYTICS_NOW)
    ).rejects.toThrow();
  });

  it("reports truncation without silently presenting complete history", async () => {
    const result = await getBaselines(
      analyticsClient(0, {
        "/v2/recovery": {
          records: Array.from({ length: 501 }, (_, index) => recoveryFixture(index)),
          next_token: "more",
        },
      }),
      { baseline_days: 180 },
      ANALYTICS_NOW
    );
    expect(result.truncated).toBe(true);
    expect(result.data_quality.sources.recovery?.records_fetched).toBe(500);
    expect(result.data_quality.limitations.join(" ")).toContain("Partial history");
  });
});
