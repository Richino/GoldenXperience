import { formatMoney, formatR, formatRatio, formatSignedMoney } from "@/lib/format";
import { formatPrice, pricePrecision } from "@/lib/instruments";
import { buildActiveSignals } from "@/lib/signals";
import type { StrategySetup } from "@/types/api";

describe("instrument precision", () => {
  it("uses 5 decimals for major pairs and 3 for JPY quotes", () => {
    expect(pricePrecision("EUR_USD")).toBe(5);
    expect(pricePrecision("USD_JPY")).toBe(3);
    expect(formatPrice(1.176141, "EUR_USD")).toBe("1.17614");
    expect(formatPrice(147.8203, "USD_JPY")).toBe("147.820");
  });
});

describe("financial formatting", () => {
  it("formats money, signed money, R and ratios", () => {
    expect(formatMoney(82167.1)).toBe("$82,167.10");
    expect(formatSignedMoney(116.42)).toBe("+$116.42");
    expect(formatSignedMoney(-30.2)).toBe("-$30.20");
    expect(formatR(1.24)).toBe("+1.24R");
    expect(formatR(-0.32)).toBe("-0.32R");
    expect(formatR(null)).toBe("—");
    expect(formatRatio(2)).toBe("1:2");
    expect(formatRatio(1.5)).toBe("1:1.5");
  });
});

describe("buildActiveSignals", () => {
  const base: StrategySetup = {
    status: "valid",
    instrument: "EUR_USD",
    pair: "EUR/USD",
    direction: "long",
    timeframe: "15m",
    entry: 1.1,
    stop: 1.09,
    target: 1.12,
    riskReward: 2,
    positionSize: { standardLots: 0.5 },
    summary: "ready",
    evaluatedAt: "2026-09-09T10:00:00Z",
  };

  it("promotes a setup with an open trade to triggered and drops invalid ones", () => {
    const setups: StrategySetup[] = [
      base,
      { ...base, instrument: "USD_JPY", status: "developing", summary: "forming" },
      { ...base, instrument: "GBP_USD", status: "invalid" },
      { ...base, instrument: "AUD_USD", direction: null },
    ];
    const plans = [{ instrument: "EUR_USD", openTradeId: "trade-1" }];
    const signals = buildActiveSignals(setups, plans, { EUR_USD: { bid: 1.105, ask: 1.106 } });

    // invalid + directionless setups are excluded
    expect(signals.map((s) => s.instrument).sort()).toEqual(["EUR_USD", "USD_JPY"]);
    const eur = signals.find((s) => s.instrument === "EUR_USD");
    const jpy = signals.find((s) => s.instrument === "USD_JPY");
    expect(eur?.status).toBe("triggered");
    expect(eur?.current).toBeCloseTo(1.1055, 4);
    expect(jpy?.status).toBe("watching");
    expect(jpy?.note).toBe("forming");
  });
});
