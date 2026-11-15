import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { LiveVolumeProfile } from "@/lib/volume-profile";

type Target = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** Uses the main pane's price scale without adding a series or changing autoscale. */
export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  private attachment: SeriesAttachedParameter<Time> | null = null;
  private live: LiveVolumeProfile | null | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly views: readonly IPrimitivePaneView[] = [{
    zOrder: () => "bottom",
    renderer: () => ({ draw: (target) => this.draw(target) }),
  }];

  constructor(private readonly dark: boolean) {}

  attached(attachment: SeriesAttachedParameter<Time>) {
    this.attachment = attachment;
  }

  detached() {
    clearTimeout(this.expiryTimer);
    this.attachment = null;
  }

  setProfile(live: LiveVolumeProfile | null | undefined) {
    if (live?.candleEnd !== this.live?.candleEnd) {
      clearTimeout(this.expiryTimer);
      if (live && live.candleEnd > Date.now()) {
        this.expiryTimer = setTimeout(() => {
          this.live = undefined;
          this.attachment?.requestUpdate();
        }, live.candleEnd - Date.now());
      }
    }
    this.live = live;
    this.attachment?.requestUpdate();
  }

  paneViews() {
    return this.views;
  }

  private draw(target: Target) {
    const attachment = this.attachment;
    if (!attachment || this.live === null) return;
    const { series } = attachment;
    const profile = this.live && this.live.candleEnd > Date.now() ? this.live.profile : null;
    const accent = this.dark ? "#f8cd64" : "#805000";
    const boundary = this.dark ? "#89d9ec" : "#12677e";
    const ink = this.dark ? "#dbf2f9" : "#234650";
    const labelBackground = this.dark ? "#131d25" : "#f1f7fa";

    target.useMediaCoordinateSpace(({ context, mediaSize: { width, height } }) => {
      const right = width - 6;
      const maxWidth = Math.min(156, width * 0.23);
      const label = (text: string, y: number, color: string) => {
        const labelWidth = context.measureText(text).width + 10;
        context.fillStyle = labelBackground;
        context.fillRect(right - labelWidth, y - 7, labelWidth, 14);
        context.fillStyle = color;
        context.fillText(text, right - 5, y);
      };

      context.save();
      context.font = "600 10px ui-monospace, monospace";
      context.textAlign = "right";
      context.textBaseline = "middle";
      if (profile) {
        const { rows, poc, pocPrice, valueArea } = profile;
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          if (row.volume <= 0) continue;
          const top = series.priceToCoordinate(row.high);
          const bottom = series.priceToCoordinate(row.low);
          if (top === null || bottom === null) continue;
          const barWidth = row.volume / rows[poc].volume * maxWidth;
          const rowHeight = Math.max(1, Math.abs(bottom - top) - 1);
          const y = (top + bottom - rowHeight) / 2;
          context.fillStyle = i === poc
            ? (this.dark ? "rgba(248,205,100,.55)" : "rgba(193,123,17,.48)")
            : i >= valueArea.first && i <= valueArea.last
              ? (this.dark ? "rgba(72,181,209,.42)" : "rgba(27,130,160,.36)")
              : (this.dark ? "rgba(130,154,172,.29)" : "rgba(75,105,127,.27)");
          context.fillRect(right - barWidth, y, barWidth, rowHeight);
        }

        const labeled: number[] = [];
        const priceFormat = series.priceFormatter();
        const level = (name: string, price: number, color: string, dashed: boolean) => {
          const y = series.priceToCoordinate(price);
          if (y === null || y < 0 || y > height) return;
          context.strokeStyle = color;
          context.globalAlpha = dashed ? 0.43 : 0.82;
          context.setLineDash(dashed ? [4, 4] : []);
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(right, y);
          context.stroke();
          context.globalAlpha = 1;
          if (y > 32 && y < height - 8 && labeled.every((other) => Math.abs(other - y) >= 15)) {
            label(`${name} ${priceFormat.format(price)}`, y, color);
            labeled.push(y);
          }
        };
        level("Dev POC", pocPrice, accent, false);
        if (valueArea.high > valueArea.low) {
          level("VAH", valueArea.high, boundary, true);
          level("VAL", valueArea.low, boundary, true);
        }
      }
      const title = profile ? `Live candle · ${profile.quoteCount} quotes` : "Live candle · waiting for quotes";
      label(title, 18, ink);
      context.restore();
    });
  }
}
