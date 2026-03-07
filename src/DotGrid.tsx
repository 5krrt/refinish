import { useEffect, useRef } from "react";

interface CompressingFile {
  path: string;
  name: string;
  done: boolean;
}

export interface DotGridProps {
  appState: "idle" | "compressing" | "done";
  isDragOver: boolean;
  files: CompressingFile[];
  sliderEl: HTMLDivElement | null;
  quality: number;
  settleComplete: boolean;
  onSettleComplete: () => void;
}

const DOT = 4;
const GAP = 3;
const CELL = DOT + GAP;

const VERDIGRIS = [0x43, 0xB3, 0xAE] as const;
const NEUTRAL = [0x6B, 0x64, 0x59] as const;
const BG_NEUTRAL = "#242424";

function lerpColor(a: readonly [number, number, number], b: readonly [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

function makeDotStamp(color: string): HTMLCanvasElement {
  const dpr = devicePixelRatio;
  const c = document.createElement("canvas");
  c.width = DOT * dpr;
  c.height = DOT * dpr;
  const dc = c.getContext("2d")!;
  dc.scale(dpr, dpr);
  dc.fillStyle = color;
  dc.beginPath();
  dc.roundRect(0, 0, DOT, DOT, 1);
  dc.fill();
  return c;
}

const BLEND_STEPS = 11; // 0.0, 0.1, ..., 1.0

function makeBlendStamps(): HTMLCanvasElement[] {
  const stamps: HTMLCanvasElement[] = [];
  for (let i = 0; i < BLEND_STEPS; i++) {
    const t = i / (BLEND_STEPS - 1);
    stamps.push(makeDotStamp(lerpColor(NEUTRAL, VERDIGRIS, t)));
  }
  return stamps;
}

export default function DotGrid({
  appState,
  isDragOver,
  files,
  sliderEl,
  quality,
  settleComplete,
  onSettleComplete,
}: DotGridProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const runningRef = useRef(false);

  // Mutable state for the rAF loop
  const s = useRef({
    appState,
    isDragOver,
    files,
    sliderEl,
    quality,
    settleComplete,
    dragBlend: 0,
    progressStarts: null as number[] | null,
    settleStart: null as number | null,
    settleNotified: false,
    lastDpr: devicePixelRatio,
    cols: 0,
    rows: 0,
    canvasW: 0,
    canvasH: 0,
    stamps: null as { verdigris: HTMLCanvasElement; bgNeutral: HTMLCanvasElement; blend: HTMLCanvasElement[] } | null,
  });

  // Sync props into mutable ref
  const prev = s.current;
  prev.appState = appState;
  prev.isDragOver = isDragOver;
  prev.files = files;
  prev.sliderEl = sliderEl;
  prev.quality = quality;
  prev.settleComplete = settleComplete;

  if (appState !== "done") {
    prev.settleStart = null;
    prev.settleNotified = false;
  }

  // Reset progress starts when new compression begins
  useEffect(() => {
    if (appState === "compressing") {
      s.current.progressStarts = files.map((_, i) => performance.now() + i * 150);
    } else if (appState === "idle") {
      s.current.progressStarts = null;
    }
  }, [appState]);

  // Wake the rAF loop whenever props change
  useEffect(() => {
    if (!runningRef.current && canvasRef.current) {
      runningRef.current = true;
      rafRef.current = requestAnimationFrame(() => drawRef.current?.());
    }
  }, [appState, isDragOver, quality, sliderEl, files]);

  const drawRef = useRef<(() => void) | undefined>(undefined);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const now = performance.now();
    const st = s.current;
    const dpr = devicePixelRatio;
    const { cols, rows, canvasW, canvasH } = st;

    if (cols === 0 || rows === 0 || !st.stamps) {
      rafRef.current = requestAnimationFrame(draw);
      return;
    }

    // Animate dragBlend
    const dragTarget = st.isDragOver ? 1 : 0;
    // Use fixed 16ms timestep for simplicity (close enough at 60fps)
    st.dragBlend += (dragTarget - st.dragBlend) * (1 - Math.exp(-8 * 0.016));
    if (Math.abs(st.dragBlend - dragTarget) < 0.005) st.dragBlend = dragTarget;
    const dragAnimating = st.dragBlend !== dragTarget;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    const gridW = cols * DOT + (cols - 1) * GAP;
    const gridH = rows * DOT + (rows - 1) * GAP;
    const ox = (canvasW - gridW) / 2;
    const oy = (canvasH - gridH) / 2;

    const stamps = st.stamps;

    // Slider region in grid coordinates — read bounds live from the DOM element
    let slColStart = -1, slColEnd = -1, slRowStart = -1, slRowEnd = -1, sliderCols = 0, sliderFilled = 0;
    if (st.sliderEl && (st.appState === "idle" || (st.appState === "done" && st.settleComplete))) {
      const sb = st.sliderEl.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      slColStart = Math.max(0, Math.floor((sb.left - cr.left - ox) / CELL));
      slColEnd = Math.min(cols, Math.ceil((sb.right - cr.left - ox) / CELL));
      slRowStart = Math.max(0, Math.floor((sb.top - cr.top - oy) / CELL));
      slRowEnd = Math.min(rows, Math.ceil((sb.bottom - cr.top - oy) / CELL));
      sliderCols = slColEnd - slColStart;
      sliderFilled = sliderCols > 0 ? Math.round(((st.quality - 50) / 50) * sliderCols) : 0;
    }

    if (st.appState === "idle" || (st.appState === "done" && st.settleComplete)) {
      // IDLE dots
      for (let col = 0; col < cols; col++) {
        const x = ox + col * CELL;
        const grad = cols > 1 ? col / (cols - 1) : 1;

        for (let row = 0; row < rows; row++) {
          const y = oy + row * CELL;

          // Slider region
          if (slColStart >= 0 && col >= slColStart && col < slColEnd && row >= slRowStart && row < slRowEnd) {
            if (col - slColStart < sliderFilled) {
              ctx.globalAlpha = 1;
              ctx.drawImage(stamps.verdigris, x, y, DOT, DOT);
            }
            continue;
          }

          // Normal idle + drag blend — single stamp, no overlapping layers
          const alpha = grad * (0.5 + 0.2 * st.dragBlend);
          const blendIdx = Math.round(st.dragBlend * (BLEND_STEPS - 1));
          ctx.globalAlpha = alpha;
          ctx.drawImage(stamps.blend[blendIdx], x, y, DOT, DOT);
        }
      }
    } else if (st.appState === "compressing" || st.appState === "done") {
      const fileCount = st.files.length;
      if (fileCount === 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Settle
      let settleProgresses: number[] | null = null;
      if (st.appState === "done") {
        if (st.settleStart === null) st.settleStart = now;
        settleProgresses = st.files.map((_, i) => {
          const elapsed = now - st.settleStart! - i * 100;
          return Math.min(1, Math.max(0, elapsed / 500));
        });
        if (!st.settleNotified && settleProgresses.every((p) => p >= 1)) {
          st.settleNotified = true;
          onSettleComplete();
        }
      }

      const rowsPerFile = Math.floor(rows / fileCount);
      const extraRows = rows - rowsPerFile * fileCount;

      for (let fi = 0; fi < fileCount; fi++) {
        const bandRowStart = fi * rowsPerFile + Math.min(fi, extraRows);
        const bandRows = rowsPerFile + (fi < extraRows ? 1 : 0);
        const bandRowEnd = bandRowStart + bandRows;

        let progress = 0;
        if (st.files[fi].done) {
          progress = 1;
        } else if (st.progressStarts) {
          const elapsed = Math.max(0, now - st.progressStarts[fi]);
          progress = Math.min(0.95, 1 - Math.exp((-3 * elapsed) / 5000));
        }

        const filledCols = Math.round(progress * cols);
        const settledCols = settleProgresses ? Math.round(settleProgresses[fi] * cols) : 0;

        for (let col = 0; col < cols; col++) {
          const x = ox + col * CELL;
          const filled = col < filledCols;
          const settled = settleProgresses !== null && col < settledCols;

          const stamp = filled && !settled ? stamps.verdigris : stamps.bgNeutral;
          ctx.globalAlpha = filled && !settled ? (cols > 1 ? col / (cols - 1) : 1) : 1;

          for (let row = bandRowStart; row < bandRowEnd; row++) {
            ctx.drawImage(stamp, x, oy + row * CELL, DOT, DOT);
          }
        }
      }
    }

    ctx.globalAlpha = 1;

    // Continue loop or sleep
    const needsAnim =
      dragAnimating ||
      st.appState === "compressing" ||
      (st.appState === "done" && !st.settleNotified);

    if (needsAnim) {
      rafRef.current = requestAnimationFrame(draw);
    } else {
      runningRef.current = false;
    }
  }

  drawRef.current = draw;

  // Main setup effect — ResizeObserver + stamp creation
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const st = s.current;
    st.stamps = {
      verdigris: makeDotStamp(lerpColor(NEUTRAL, VERDIGRIS, 1)),
      bgNeutral: makeDotStamp(BG_NEUTRAL),
      blend: makeBlendStamps(),
    };

    const resize = () => {
      const dpr = devicePixelRatio;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      st.canvasW = w;
      st.canvasH = h;
      st.cols = Math.floor(w / CELL);
      st.rows = Math.floor(h / CELL);

      if (dpr !== st.lastDpr) {
        st.stamps = {
          verdigris: makeDotStamp(lerpColor(NEUTRAL, VERDIGRIS, 1)),
          bgNeutral: makeDotStamp(BG_NEUTRAL),
          blend: makeBlendStamps(),
        };
        st.lastDpr = dpr;
      }

      // Draw synchronously so the canvas is never blank after resize clears it.
      // Cancel any pending rAF first to avoid double-drawing.
      cancelAnimationFrame(rafRef.current);
      runningRef.current = true;
      drawRef.current?.();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    // Initial draw
    runningRef.current = true;
    rafRef.current = requestAnimationFrame(() => drawRef.current?.());

    return () => {
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 z-0" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />
    </div>
  );
}
