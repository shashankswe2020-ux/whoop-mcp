import { describe, it, expect } from "vitest";
import { getSleepDebt } from "../../src/tools/get-sleep-debt.js";
import { analyticsClient, ANALYTICS_NOW, sleepFixture } from "../helpers/analytics-fixtures.js";

describe("getSleepDebt", () => {
  it("resolves relative dates against the injected evaluation clock", async () => {
    const result = await getSleepDebt(
      analyticsClient(),
      { start: "yesterday", days: 3 },
      new Date("2026-08-10T12:00:00Z")
    );
    expect(result.period.start).toBe("2026-08-09T00:00:00.000Z");
  });

  it.each([{ records: "invalid" }, {}, { records: [], next_token: 42 }])(
    "distinguishes malformed pages %j from network failures",
    async (page) => {
      const result = await getSleepDebt(
        analyticsClient(0, { "/v2/activity/sleep": page }),
        {},
        ANALYTICS_NOW
      );
      expect(result.status).toBe("insufficient_data");
      expect(result.data_quality.sources.sleep?.status).toBe("invalid");
    }
  );

  it("preserves nap adjustment, uses asleep stages, and separates standing debt", async () => {
    const result = await getSleepDebt(analyticsClient(4), {}, ANALYTICS_NOW);
    expect(result.nights[0]).toMatchObject({ needed_hours: 8, achieved_hours: 7, debt_hours: 1 });
    expect(result.total_debt_hours).toBe(4);
    expect(result.standing_debt_hours).toBe(5);
    expect(result.consistency.bedtime_std_dev_minutes).toBeCloseTo(0);
  });
  it("excludes naps and pending scores, picks longest main sleep per day", async () => {
    const records = [
      sleepFixture(1),
      sleepFixture(2),
      sleepFixture(3),
      { ...sleepFixture(1), id: "nap", nap: true },
      { ...sleepFixture(4), score_state: "PENDING_SCORE" },
      { ...sleepFixture(1), id: "short", start: "2026-09-09T05:00:00Z" },
    ];
    const result = await getSleepDebt(
      analyticsClient(0, { "/v2/activity/sleep": { records } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(3);
    expect(result.total_debt_hours).toBe(3);
    expect(result.data_quality.sources.sleep?.exclusions.nap).toBe(1);
    expect(result.data_quality.sources.sleep?.exclusions.pending).toBe(1);
  });
  it("returns null aggregates for insufficient data", async () => {
    const result = await getSleepDebt(analyticsClient(2), {}, ANALYTICS_NOW);
    expect(result.total_debt_hours).toBeNull();
    expect(result.status).toBe("insufficient_data");
    expect(result.consistency.social_jetlag_minutes).toBeNull();
  });

  it("keeps weekend-only social jetlag null and treats surplus as zero deficit", async () => {
    const records = [4, 11, 18].map((index) => sleepFixture(index));
    for (const record of records) record.score!.sleep_needed.baseline_milli = 14_400_000;
    const result = await getSleepDebt(
      analyticsClient(0, { "/v2/activity/sleep": { records } }),
      { days: 30 },
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(3);
    expect(result.total_debt_hours).toBe(0);
    expect(result.consistency.social_jetlag_minutes).toBeNull();
  });

  it("rejects invalid needs and preserves missing-night counts", async () => {
    const invalid = sleepFixture(1);
    invalid.score!.sleep_needed.need_from_recent_nap_milli = -100_000_000;
    const result = await getSleepDebt(
      analyticsClient(0, {
        "/v2/activity/sleep": { records: [invalid, sleepFixture(2), sleepFixture(5)] },
      }),
      {},
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(2);
    expect(result.total_debt_hours).toBeNull();
    expect(result.data_quality.sources.sleep?.exclusions.invalid_need).toBe(1);
  });
  it("caps echoed nights without reducing the analyzed set", async () => {
    const result = await getSleepDebt(analyticsClient(60), { days: 90 }, ANALYTICS_NOW);
    expect(result.nights).toHaveLength(30);
    expect(result.nights_analyzed).toBe(60);
    expect(result.output_capped).toBe(true);
    expect(result.truncated).toBe(false);
  });
  it("rejects future starts and returns resolved historical windows", async () => {
    await expect(
      getSleepDebt(analyticsClient(), { start: "2027-01-01" }, ANALYTICS_NOW)
    ).rejects.toThrow();
    const result = await getSleepDebt(
      analyticsClient(),
      { start: "2026-09-01", days: 3 },
      ANALYTICS_NOW
    );
    expect(result.period).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-04T00:00:00.000Z",
    });
  });
});
