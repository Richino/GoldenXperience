import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { AppText } from "@/components/ui/AppText";
import { Card } from "@/components/ui/Card";
import { SideTag } from "@/components/ui/Tags";
import { SectionHeader } from "@/components/ui/Section";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { displayNameFor, formatPrice } from "@/lib/instruments";
import { formatRatio, relativeTime } from "@/lib/format";
import type { WatchRow } from "@/types/api";

/** Watchlist rows that carry a full, directional setup — the home "signals". */
export function homeSignalRows(watchlist: WatchRow[]): WatchRow[] {
  return watchlist
    .filter((row) => row.entry !== null && row.stop !== null && row.target !== null && row.direction)
    .slice(0, 4);
}

export function ActiveSignals({ rows, onSeeAll }: { rows: WatchRow[]; onSeeAll: () => void }) {
  const router = useRouter();
  if (rows.length === 0) return null;

  return (
    <View>
      <SectionHeader title="Active signals" action={{ label: "See all", onPress: onSeeAll }} />
      <View style={{ gap: spacing.md }}>
        {rows.map((row) => {
          const entry = row.entry as number;
          const stop = row.stop as number;
          const target = row.target as number;
          const risk = Math.abs(entry - stop);
          const reward = Math.abs(target - entry);
          const ratio = risk > 0 ? reward / risk : null;
          return (
            <Pressable key={row.instrument} onPress={() => router.push("/signals")}>
              <Card>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <AppText size="md" weight="700">
                      {displayNameFor(row.instrument)}
                    </AppText>
                    <SideTag direction={row.direction as "long" | "short"} />
                  </View>
                  <AppText tone="muted" size="xs">
                    {relativeTime(row.evaluatedAt)}
                  </AppText>
                </View>
                <View style={{ flexDirection: "row", marginTop: spacing.md, gap: spacing.lg }}>
                  <Leg label="Entry" value={formatPrice(entry, row.instrument)} />
                  <Leg label="SL" value={formatPrice(stop, row.instrument)} tone="negative" />
                  <Leg label="TP" value={formatPrice(target, row.instrument)} tone="positive" />
                  <Leg label="R:R" value={formatRatio(ratio)} />
                </View>
              </Card>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Leg({
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
    <View style={{ gap: 3 }}>
      <AppText tone="muted" eyebrow>
        {label}
      </AppText>
      <AppText size="sm" weight="600" mono style={{ color }}>
        {value}
      </AppText>
    </View>
  );
}
