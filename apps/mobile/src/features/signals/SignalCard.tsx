import { memo } from "react";
import { View } from "react-native";
import { Card } from "@/components/ui/Card";
import { AppText } from "@/components/ui/AppText";
import { SideTag, StatusPill } from "@/components/ui/Tags";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { formatPrice } from "@/lib/instruments";
import { formatR, formatRatio, relativeTime } from "@/lib/format";
import { signalProgress, type ActiveSignal } from "@/lib/signals";
import { useQuote } from "@/realtime/MarketStreamProvider";

/**
 * A full active-signal card. It reads its own live quote so a tick updates the
 * current price, the progress marker and the open-R on this card alone. Shows
 * every field the brief lists (§10): pair, side, strategy, timeframe, status,
 * entry, SL, TP, R:R, current price and timestamp.
 */
export const SignalCard = memo(function SignalCard({ signal }: { signal: ActiveSignal }) {
  const colors = useColors();
  const quote = useQuote(signal.instrument);
  const current = quote ? quote.mid : signal.current;
  const withCurrent = { ...signal, current };
  const fraction = signalProgress(withCurrent);

  const openR =
    current === null || signal.entry === signal.stop
      ? null
      : ((current - signal.entry) / Math.abs(signal.entry - signal.stop)) * (signal.direction === "long" ? 1 : -1);

  const foot =
    signal.status === "watching"
      ? signal.note ?? "Awaiting confirmation"
      : signal.status === "triggered"
        ? `Filled ${formatPrice(signal.fillPrice ?? signal.entry, signal.instrument)}${signal.lots !== null ? ` · ${signal.lots.toFixed(2)} lot` : ""}`
        : `Risk ${signal.riskPercent.toFixed(1)}%${signal.lots !== null ? ` · ${signal.lots.toFixed(2)} lot` : ""}`;

  return (
    <Card>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 }}>
          <AppText size="md" weight="700">
            {signal.pair}
          </AppText>
          <SideTag direction={signal.direction} />
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <StatusPill status={signal.status} />
          <AppText tone="muted" size="xs">
            {relativeTime(signal.evaluatedAt)}
          </AppText>
        </View>
      </View>
      <AppText tone="secondary" size="xs" style={{ marginTop: 4 }}>
        {signal.strategy} · {signal.timeframe}
      </AppText>

      <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: spacing.md, rowGap: spacing.md }}>
        <Stat label="Entry" value={formatPrice(signal.entry, signal.instrument)} />
        <Stat label="Stop loss" value={formatPrice(signal.stop, signal.instrument)} tone="negative" />
        <Stat label="Take profit" value={formatPrice(signal.target, signal.instrument)} tone="positive" />
        <Stat label="R:R" value={formatRatio(signal.riskReward)} />
        <Stat label="Current" value={current === null ? "—" : formatPrice(current, signal.instrument)} />
      </View>

      <ProgressTrack fraction={fraction} />

      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.md }}>
        <AppText tone="muted" size="xs" style={{ flexShrink: 1 }}>
          {foot}
        </AppText>
        {openR !== null ? (
          <AppText size="xs" mono weight="600" style={{ color: openR >= 0 ? colors.positive : colors.negative }}>
            {formatR(openR, 1)} open
          </AppText>
        ) : null}
      </View>
    </Card>
  );
});

function Stat({
  label,
  value,
  tone = "primary",
}: {
  label: string;
  value: string;
  tone?: "primary" | "positive" | "negative";
}) {
  const colors = useColors();
  const color = tone === "positive" ? colors.positive : tone === "negative" ? colors.negative : colors.textPrimary;
  return (
    <View style={{ width: "20%", minWidth: 64, gap: 3 }}>
      <AppText tone="muted" eyebrow>
        {label}
      </AppText>
      <AppText size="sm" weight="600" mono style={{ color }}>
        {value}
      </AppText>
    </View>
  );
}

function ProgressTrack({ fraction }: { fraction: number }) {
  const colors = useColors();
  const pct = Math.min(96, Math.max(4, fraction * 100));
  return (
    <View style={{ marginTop: spacing.lg, height: 6, borderRadius: 3, backgroundColor: colors.surfaceMuted, justifyContent: "center" }}>
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, borderRadius: 2, backgroundColor: colors.negative }} />
      <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 4, borderRadius: 2, backgroundColor: colors.positive }} />
      <View
        style={{
          position: "absolute",
          left: `${pct}%`,
          width: 12,
          height: 12,
          borderRadius: 6,
          marginLeft: -6,
          backgroundColor: colors.gxAccent,
          borderWidth: 2,
          borderColor: colors.surface,
        }}
      />
    </View>
  );
}
