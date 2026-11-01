import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import { LONDON_TIME_ZONE, NEW_YORK_TIME_ZONE, sessionHour } from "@/lib/strategy/session";
import type { Candle } from "@/types/forex";

/**
 * The workstation chart's backdrop (canvas "Chart · Desktop"): full-height
 * London and New York session bands with their names along the top, and
 * quiet volume bars along the bottom. Drawn behind the candles from the
 * candles themselves, so it needs no series of its own.
 */

export interface ChartBackdropColors {
  londonBand: string;
  newYorkBand: string;
  londonLabel: string;
  newYorkLabel: string;
  volume: string;
}

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

const DAY_MS = 86_400_000;
/** Sessions read as bands only below 4H; on 4H and up they are a candle or two. */
const MAX_SESSION_BAR_SECONDS = 2 * 3_600;
/** Volume bars fill at most this share of the pane's height. */
const VOLUME_SHARE = 0.12;

interface Window { name: "london" | "newYork"; start: number; end: number }
interface PixelBand { x1: number; x2: number; name: Window["name"] }
interface PixelBar { x: number; width: number; height: number }

/** London and New York 08:00–17:00 local, each on its own DST clock. */
function sessionWindows(firstMs: number, lastMs: number): Window[] {
  const windows: Window[] = [];
  for (let day = firstMs - (firstMs % DAY_MS) - DAY_MS; day <= lastMs; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    windows.push({ name: "london", start: sessionHour(day, 8, LONDON_TIME_ZONE), end: sessionHour(day, 17, LONDON_TIME_ZONE) });
    windows.push({ name: "newYork", start: sessionHour(day, 8, NEW_YORK_TIME_ZONE), end: sessionHour(day, 17, NEW_YORK_TIME_ZONE) });
  }
  return windows;
}

class BackdropRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly bands: PixelBand[],
    private readonly bars: PixelBar[],
    private readonly colors: ChartBackdropColors,
    private readonly fontFamily: string,
  ) {}

  draw() {}

  drawBackground(target: RenderTarget) {
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio: h, verticalPixelRatio: v }) => {
      for (const band of this.bands) {
        const x = Math.round(band.x1 * h);
        const width = Math.max(1, Math.round((band.x2 - band.x1) * h));
        context.fillStyle = band.name === "london" ? this.colors.londonBand : this.colors.newYorkBand;
        context.fillRect(x, 0, width, bitmapSize.height);
      }
      context.fillStyle = this.colors.volume;
      for (const bar of this.bars) {
        const height = Math.max(1, Math.round(bar.height * v));
        context.fillRect(Math.round(bar.x * h), bitmapSize.height - height, Math.max(1, Math.round(bar.width * h)), height);
      }
      context.font = `600 ${Math.round(10 * v)}px ${this.fontFamily}`;
      context.textBaseline = "top";
      // Name only the latest London and New York bands; the earlier days'
      // bands read the same without repeating their labels.
      const latest = new Map(this.bands.map((band) => [band.name, band]));
      for (const band of latest.values()) {
        if (band.x2 - band.x1 < 70) continue;
        context.fillStyle = band.name === "london" ? this.colors.londonLabel : this.colors.newYorkLabel;
        context.fillText(band.name === "london" ? "LONDON" : "NEW YORK", Math.round((band.x1 + 6) * h), Math.round(8 * v));
      }
    });
  }
}

export class ChartBackdropPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private candles: Candle[] = [];
  private bands: PixelBand[] = [];
  private bars: PixelBar[] = [];

  constructor(
    private colors: ChartBackdropColors,
    private readonly fontFamily: string,
  ) {}

  setCandles(candles: Candle[]) {
    this.candles = candles;
    this.requestUpdate?.();
  }

  setColors(colors: ChartBackdropColors) {
    this.colors = colors;
    this.requestUpdate?.();
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews() {
    const chart = this.chart;
    const series = this.series;
    this.bands = [];
    this.bars = [];
    if (!chart || !series || this.candles.length < 2) return;
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const barSpacing = timeScale.options().barSpacing;
    const first = Math.max(0, Math.floor(range.from));
    const last = Math.min(this.candles.length - 1, Math.ceil(range.to));
    if (last <= first) return;

    // Volume: scaled to the loudest candle in view.
    const visible = this.candles.slice(first, last + 1);
    const loudest = Math.max(...visible.map((candle) => candle.volume), 0);
    const paneHeight = chart.paneSize().height;
    if (loudest > 0) {
      const width = Math.max(1, barSpacing * 0.6);
      visible.forEach((candle, index) => {
        const x = timeScale.logicalToCoordinate((first + index) as import("lightweight-charts").Logical);
        if (x === null) return;
        this.bars.push({ x: x - width / 2, width, height: (candle.volume / loudest) * paneHeight * VOLUME_SHARE });
      });
    }

    // Sessions: intraday only, snapped to the bars that fall inside them.
    const times = this.candles.map((candle) => Date.parse(candle.time));
    const barMs = times[times.length - 1]! - times[times.length - 2]!;
    if (!(barMs > 0) || barMs / 1_000 > MAX_SESSION_BAR_SECONDS) return;
    for (const window of sessionWindows(times[first]!, times[last]!)) {
      let startIndex = -1;
      let endIndex = -1;
      for (let index = first; index <= last; index += 1) {
        const ms = times[index]!;
        if (ms < window.start || ms >= window.end) continue;
        if (startIndex < 0) startIndex = index;
        endIndex = index;
      }
      if (startIndex < 0) continue;
      const x1 = timeScale.logicalToCoordinate(startIndex as import("lightweight-charts").Logical);
      const x2 = timeScale.logicalToCoordinate(endIndex as import("lightweight-charts").Logical);
      if (x1 === null || x2 === null) continue;
      this.bands.push({ x1: x1 - barSpacing / 2, x2: x2 + barSpacing / 2, name: window.name });
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const { bands, bars, colors, fontFamily } = this;
    return [{ zOrder: () => "bottom", renderer: () => new BackdropRenderer(bands, bars, colors, fontFamily) }];
  }
}
