import { memo } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { AppText } from "@/components/ui/AppText";
import { SideTag } from "@/components/ui/Tags";
import { SectionHeader } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { displayNameFor, formatPrice } from "@/lib/instruments";
import { formatR, formatSignedMoney } from "@/lib/format";
import { useQuote } from "@/realtime/MarketStreamProvider";
import { markOpenTrade } from "@/features/home/useHomeData";
import type { OverviewTrade } from "@/types/api";

interface OpenPositionsProps {
  trades: OverviewTrade[];
  currency: string;
  onSeeAll: () => void;
}

export function OpenPositions({ trades, currency, onSeeAll }: OpenPositionsProps) {
  const colors = useColors();
  return (
    <View>
      <SectionHeader title="Open positions" action={trades.length ? { label: "View all", onPress: onSeeAll } : undefined} />
      {trades.length === 0 ? (
        <EmptyState title="No open positions" hint="Live positions from your GX account will appear here." />
      ) : (
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
          {trades.slice(0, 6).map((trade, index) => (
            <OpenPositionRow
              key={trade.id}
              trade={trade}
              currency={currency}
              isLast={index === Math.min(trades.length, 6) - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const OpenPositionRow = memo(function OpenPositionRow({
  trade,
  currency,
  isLast,
}: {
  trade: OverviewTrade;
  currency: string;
  isLast: boolean;
}) {
  const colors = useColors();
  const router = useRouter();
  const quote = useQuote(trade.instrument);
  const mid = quote ? quote.mid : null;
  const { money, openR } = markOpenTrade(trade, mid);

  const plTone = money === null ? "muted" : money >= 0 ? "positive" : "negative";
  const rTone = openR === null ? "muted" : openR >= 0 ? "positive" : "negative";

  return (
    <Pressable
      onPress={() => router.push(`/trades/${trade.id}`)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      })}
    >
      <View style={{ flex: 1.4, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <AppText size="sm" weight="700">
          {displayNameFor(trade.instrument)}
        </AppText>
        <SideTag direction={trade.direction} />
      </View>
      <View style={{ flex: 1, alignItems: "flex-end" }}>
        <AppText size="sm" mono>
          {mid === null ? "—" : formatPrice(mid, trade.instrument)}
        </AppText>
        <AppText tone="muted" size="xs" mono>
          {trade.entry == null ? "—" : formatPrice(trade.entry, trade.instrument)}
        </AppText>
      </View>
      <View style={{ flex: 0.8, alignItems: "flex-end" }}>
        <AppText size="sm" mono tone={rTone}>
          {formatR(openR)}
        </AppText>
      </View>
      <View style={{ flex: 1.1, alignItems: "flex-end" }}>
        <AppText size="sm" weight="600" mono tone={plTone}>
          {money === null ? "Open" : formatSignedMoney(money, currency)}
        </AppText>
      </View>
    </Pressable>
  );
});
