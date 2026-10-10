import {
  customSeriesDefaultOptions,
  type CandlestickData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from "lightweight-charts";

/**
 * Candlesticks with softly rounded bodies. Lightweight Charts' own candles
 * are square-cornered and have no radius option, so the main chart draws its
 * candle, hollow and Heikin-Ashi variants through this custom series instead.
 * Same data shape as a candlestick series, so `setData` / `update`, price
 * lines, markers and autoscale behave as before.
 */
export type RoundedCandleData = CandlestickData<Time>;

export interface RoundedCandleOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  wickUpColor: string;
  wickDownColor: string;
  borderUpColor: string;
  borderDownColor: string;
  borderVisible: boolean;
  /** Corner radius of a candle body, in CSS pixels. */
  radius: number;
}

const DEFAULTS: RoundedCandleOptions = {
  ...customSeriesDefaultOptions,
  upColor: "#26a69a",
  downColor: "#ef5350",
  wickUpColor: "#26a69a",
  wickDownColor: "#ef5350",
  borderUpColor: "#26a69a",
  borderDownColor: "#ef5350",
  borderVisible: true,
  radius: 2,
};

type RenderTarget = Parameters<ICustomSeriesPaneRenderer["draw"]>[0];

class RoundedCandleRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, RoundedCandleData> | null = null;
  private options: RoundedCandleOptions = DEFAULTS;

  update(data: PaneRendererCustomData<Time, RoundedCandleData>, options: RoundedCandleOptions) {
    this.data = data;
    this.options = options;
  }

  draw(target: RenderTarget, priceToCoordinate: PriceToCoordinateConverter) {
    const data = this.data;
    const range = data?.visibleRange;
    if (!data || !range) return;
    const options = this.options;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      // Same proportions as the library's candles: ~80% of the slot, a
      // 1-device-pixel wick, and always at least a pixel of gap between bars.
      const spacing = data.barSpacing * Math.max(1, data.conflationFactor || 1) * hpr;
      let body = Math.max(1, Math.floor(spacing * 0.8));
      if (spacing - body < 1 && body > 1) body -= 1;
      const wick = Math.max(1, Math.floor(hpr));
      const border = options.borderVisible ? Math.max(1, Math.floor(hpr)) : 0;

      for (let index = range.from; index < range.to; index += 1) {
        const bar = data.bars[index];
        if (!bar) continue;
        const candle = bar.originalData;
        const open = priceToCoordinate(candle.open);
        const close = priceToCoordinate(candle.close);
        const high = priceToCoordinate(candle.high);
        const low = priceToCoordinate(candle.low);
        if (open === null || close === null || high === null || low === null) continue;
        const up = candle.close >= candle.open;
        const center = Math.round(bar.x * hpr);

        // Wick, high to low.
        const wickTop = Math.round(Math.min(high, low) * vpr);
        const wickBottom = Math.round(Math.max(high, low) * vpr);
        ctx.fillStyle = up ? options.wickUpColor : options.wickDownColor;
        ctx.fillRect(center - Math.floor(wick / 2), wickTop, wick, Math.max(1, wickBottom - wickTop));

        // Body, rounded once it is big enough for the corners to read.
        const top = Math.round(Math.min(open, close) * vpr);
        const height = Math.max(1, Math.round(Math.max(open, close) * vpr) - top);
        const left = center - Math.floor(body / 2);
        // A quarter of the body width at most, so thin candles stay candles.
        const radius = Math.min(options.radius * hpr, body * 0.25, height / 2);
        const fill = up ? options.upColor : options.downColor;
        const stroke = up ? options.borderUpColor : options.borderDownColor;
        const shape = (x: number, y: number, w: number, h: number, r: number) => {
          ctx.beginPath();
          if (r >= 1 && typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
          else ctx.rect(x, y, w, h);
        };

        if (border && stroke !== fill && body > 2 * border && height > 2 * border) {
          // Hollow-style: the border colour outside, the fill inset within it.
          ctx.fillStyle = stroke;
          shape(left, top, body, height, radius);
          ctx.fill();
          ctx.fillStyle = fill;
          shape(left + border, top + border, body - 2 * border, height - 2 * border, Math.max(0, radius - border));
          ctx.fill();
        } else {
          ctx.fillStyle = fill;
          shape(left, top, body, height, radius);
          ctx.fill();
        }
      }
    });
  }
}

export class RoundedCandleSeries
  implements ICustomSeriesPaneView<Time, RoundedCandleData, RoundedCandleOptions>
{
  private readonly paneRenderer = new RoundedCandleRenderer();

  renderer() {
    return this.paneRenderer;
  }

  update(data: PaneRendererCustomData<Time, RoundedCandleData>, options: RoundedCandleOptions) {
    this.paneRenderer.update(data, options);
  }

  priceValueBuilder(candle: RoundedCandleData): CustomSeriesPricePlotValues {
    return [candle.low, candle.high, candle.close];
  }

  isWhitespace(
    data: RoundedCandleData | CustomSeriesWhitespaceData<Time>,
  ): data is CustomSeriesWhitespaceData<Time> {
    return (data as Partial<RoundedCandleData>).close === undefined;
  }

  defaultOptions() {
    return DEFAULTS;
  }
}
