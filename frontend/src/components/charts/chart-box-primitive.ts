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

/** A filled time/price rectangle drawn behind the candles. */
export interface ChartBox {
  key: string;
  startTime: string;
  endTime: string;
  top: number;
  bottom: number;
  /** Solid colour; the fill and border alphas are applied here. */
  color: string;
  label?: string;
  /** Lighter fill and a dashed edge, for boxes that only partly qualify. */
  faded?: boolean;
}

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

interface PixelBox { x1: number; x2: number; y1: number; y2: number; color: string; label?: string; faded?: boolean }

function withAlpha(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class BoxRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly boxes: PixelBox[]) {}

  draw() {}

  drawBackground(target: RenderTarget) {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio: h, verticalPixelRatio: v }) => {
      for (const box of this.boxes) {
        const x = Math.round(box.x1 * h);
        const y = Math.round(Math.min(box.y1, box.y2) * v);
        const width = Math.max(1, Math.round((box.x2 - box.x1) * h));
        const height = Math.max(1, Math.round(Math.abs(box.y2 - box.y1) * v));
        context.fillStyle = withAlpha(box.color, box.faded ? 0.05 : 0.14);
        context.fillRect(x, y, width, height);
        context.strokeStyle = withAlpha(box.color, box.faded ? 0.45 : 0.7);
        context.lineWidth = Math.max(1, Math.round(h));
        context.setLineDash(box.faded ? [4 * h, 3 * h] : []);
        context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        context.setLineDash([]);
        if (box.label && width > 14 * h) {
          context.fillStyle = withAlpha(box.color, 0.95);
          context.font = `600 ${Math.round(10 * v)}px sans-serif`;
          context.textBaseline = "top";
          context.fillText(box.label, x + 3 * h, y + 2 * v);
        }
      }
    });
  }
}

/**
 * Draws ChartBox rectangles on a series. Box times are snapped to the series'
 * own bars, so M15-timed boxes still line up on 1H/4H charts.
 */
export class ChartBoxPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private boxes: ChartBox[] = [];
  private pixels: PixelBox[] = [];

  setBoxes(boxes: ChartBox[]) {
    this.boxes = boxes;
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
    this.pixels = [];
    if (!chart || !series || !this.boxes.length) return;
    const times = series.data().map((bar) => Number(bar.time)).filter(Number.isFinite);
    if (times.length < 2) return;
    const barSeconds = times[times.length - 1]! - times[times.length - 2]!;
    const timeScale = chart.timeScale();
    const halfBar = timeScale.options().barSpacing / 2;
    // First bar whose span reaches `seconds`, i.e. the bar containing it.
    const barAt = (seconds: number) => {
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid]! <= seconds) lo = mid; else hi = mid - 1;
      }
      return times[lo]!;
    };
    for (const box of this.boxes) {
      const start = Math.floor(Date.parse(box.startTime) / 1000);
      const end = Math.floor(Date.parse(box.endTime) / 1000);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= times[0]! || start > times[times.length - 1]! + barSeconds) continue;
      const x1 = timeScale.timeToCoordinate(barAt(Math.max(start, times[0]!)) as Time);
      // The end time is exclusive: the last bar is the one before it.
      const x2 = timeScale.timeToCoordinate(barAt(Math.max(start, end - 1)) as Time);
      const y1 = series.priceToCoordinate(box.top);
      const y2 = series.priceToCoordinate(box.bottom);
      if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
      this.pixels.push({ x1: x1 - halfBar, x2: x2 + halfBar, y1, y2, color: box.color, label: box.label, faded: box.faded });
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const pixels = this.pixels;
    return [{ zOrder: () => "bottom", renderer: () => new BoxRenderer(pixels) }];
  }
}
