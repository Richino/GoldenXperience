import { memo } from "react";
import { View } from "react-native";
import { AppText } from "@/components/ui/AppText";
import { SectionHeader } from "@/components/ui/Section";
import { useColors } from "@/theme/ThemeProvider";
import { spacing } from "@/theme/tokens";
import { displayNameFor, formatPrice } from "@/lib/instruments";
import { useQuote } from "@/realtime/MarketStreamProvider";
import { MAJOR_INSTRUMENTS } from "@/types/forex";

const HOME_MARKETS = MAJOR_INSTRUMENTS.slice(0, 6);

/** A compact live-price list of the leading majors (brief §8, "Markets"). */
export function Markets() {
  const colors = useColors();
  return (
    <View>
      <SectionHeader title="Markets" />
      <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
        {HOME_MARKETS.map((instrument, index) => (
          <MarketRow key={instrument} instrument={instrument} isLast={index === HOME_MARKETS.length - 1} />
        ))}
      </View>
    </View>
  );
}

const MarketRow = memo(function MarketRow({ instrument, isLast }: { instrument: string; isLast: boolean }) {
  const colors = useColors();
  const quote = useQuote(instrument);
  const spreadPips = quote ? (quote.ask - quote.bid) / (instrument.endsWith("_JPY") ? 0.01 : 0.0001) : null;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <AppText size="sm" weight="600">
        {displayNameFor(instrument)}
      </AppText>
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <AppText size="sm" mono weight="600">
          {quote ? formatPrice(quote.mid, instrument) : "—"}
        </AppText>
        <AppText tone="muted" size="xs" mono>
          {spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pip`}
        </AppText>
      </View>
    </View>
  );
});
