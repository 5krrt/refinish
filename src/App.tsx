import { useState, useEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// Formats we can actually compress on the backend
const validExts = ["jpg", "jpeg", "png", "webp", "avif"];

// Only macOS and Windows support window translucency in Tauri — on Linux
// we fall back to a solid background so it doesn't look broken.
const supportsTranslucency = (() => {
  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  if (nav.userAgentData?.platform) {
    const p = nav.userAgentData.platform;
    return p === "macOS" || p === "Windows";
  }
  return /Mac|Win/.test(navigator.platform);
})();

// State machine: idle → compressing → done → idle
// "done" is a brief transitional state that plays the settle animation
// before resetting back to the drop zone.
type AppState = "idle" | "compressing" | "done";

interface CompressingFile {
  path: string;
  name: string;
  done: boolean;
}

interface FileProgress {
  index: number;
  result: {
    path: string;
    name: string;
    originalSize: number;
    compressedSize: number;
    savingsPercent: number;
    success: boolean;
    error: string | null;
  };
}

function usePersistedState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

// Pre-render a single rounded dot onto a tiny canvas so we can stamp it
// with drawImage instead of running path ops per dot.
function makeDotStamp(color: string): HTMLCanvasElement {
  const dpr = devicePixelRatio;
  const c = document.createElement("canvas");
  c.width = 4 * dpr;
  c.height = 4 * dpr;
  const dc = c.getContext("2d")!;
  dc.scale(dpr, dpr);
  dc.fillStyle = color;
  dc.beginPath();
  dc.roundRect(0, 0, 4, 4, 1);
  dc.fill();
  return c;
}

// Each file gets a horizontal band filled with a dot grid drawn on canvas.
// Columns light up in verdigris as progress fills left-to-right, then sweep
// back to neutral when compression finishes (the "settle" effect).
// All animation runs in a single rAF loop with no React re-renders.
function ProgressBand({
  file,
  index,
  totalFiles,
  settling,
}: {
  file: CompressingFile;
  index: number;
  totalFiles: number;
  settling: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ done: file.done, settling });
  stateRef.current.done = file.done;
  stateRef.current.settling = settling;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext("2d")!;
    const dotSize = 4;
    const gap = 3;
    const cell = dotSize + gap; // 7
    let cols = 0, rows = 0;
    const progressStart = performance.now();
    const staggerDelay = index * 150;
    const settleDelay = index * 100;
    let settleStart: number | null = null;
    let progress = 0;
    let settleProgress = 0;
    let raf: number;

    const verdigrisDot = makeDotStamp("#43B3AE");
    const neutralDot = makeDotStamp("#242424");

    const resize = () => {
      const dpr = devicePixelRatio;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      cols = Math.floor(w / cell);
      rows = Math.floor(h / cell);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    function draw() {
      if (!canvas) return;
      const now = performance.now();
      const { done, settling } = stateRef.current;
      const dpr = devicePixelRatio;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      if (done) progress = 1;
      else {
        const elapsed = Math.max(0, now - progressStart - staggerDelay);
        progress = Math.min(0.95, 1 - Math.exp(-3 * elapsed / 5000));
      }

      if (settling) {
        if (settleStart === null) settleStart = now;
        settleProgress = Math.min(1, Math.max(0, (now - settleStart - settleDelay) / 500));
      } else {
        settleStart = null;
        settleProgress = 0;
      }

      if (cols === 0 || rows === 0) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const filledCols = Math.round(progress * cols);
      const settledCols = settling ? Math.round(settleProgress * cols) : 0;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Center grid — match CSS grid sizing (no trailing gap)
      const gridW = cols * dotSize + (cols - 1) * gap;
      const gridH = rows * dotSize + (rows - 1) * gap;
      const ox = (w - gridW) / 2;
      const oy = (h - gridH) / 2;

      for (let col = 0; col < cols; col++) {
        const x = ox + col * cell;
        const filled = col < filledCols;
        const settled = settling && col < settledCols;
        const dot = filled && !settled ? verdigrisDot : neutralDot;
        ctx.globalAlpha = filled && !settled ? col / (cols - 1 || 1) : 1;

        for (let row = 0; row < rows; row++) {
          ctx.drawImage(dot, x, oy + row * cell, dotSize, dotSize);
        }
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [index]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden"
      style={{ height: `${100 / totalFiles}%` }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <div
        className="absolute bottom-3 left-4 text-sm text-gf-text font-condensed font-medium pointer-events-none"
        style={{
          textShadow: '0 1px 3px rgba(0,0,0,0.5)',
          opacity: settling ? 0 : undefined,
          transition: settling ? 'opacity 0.4s cubic-bezier(0.25, 1, 0.5, 1)' : undefined,
        }}
      >
        {file.name}
      </div>
    </div>
  );
}

function PixelSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(0);
  const rows = 5;
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect;
      const cell = 7; // 4px block + 3px gap
      flushSync(() => setCols(Math.floor(width / cell)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const valueFromX = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el || cols === 0) return value;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(50 + ratio * 50);
    },
    [cols, value]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      onChange(valueFromX(e.clientX));

      const onMove = (ev: MouseEvent) => {
        if (draggingRef.current) onChange(valueFromX(ev.clientX));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onChange, valueFromX]
  );

  const filledCols = cols > 0 ? Math.round(((value - 50) / 50) * cols) : 0;
  const totalBlocks = cols * rows;

  return (
    <div
      ref={containerRef}
      className="cursor-pointer select-none"
      style={{ height: 32 }}
      onMouseDown={handleMouseDown}
    >
      {totalBlocks > 0 && (
        <div
          className="grid w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${cols}, 4px)`,
            gridTemplateRows: `repeat(${rows}, 4px)`,
            gap: "3px",
            justifyContent: "start",
            alignContent: "center",
          }}
        >
          {Array.from({ length: totalBlocks }, (_, i) => {
            const col = i % cols;
            const filled = col < filledCols;
            return filled ? (
              <div
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 1,
                  backgroundColor: "var(--color-gf-verdigris)",
                }}
              />
            ) : (
              <div key={i} />
            );
          })}
        </div>
      )}
    </div>
  );
}

function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [compressingFiles, setCompressingFiles] = useState<CompressingFile[]>(
    []
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const compressingRef = useRef(false);
  const [quality, setQuality] = usePersistedState("refinish:quality", 80);
  const [mode, setMode] = usePersistedState<"compress" | "convert">("refinish:mode", "compress");
  const [convertFormat, setConvertFormat] = usePersistedState("refinish:convertFormat", "webp");
  const [showFormats, setShowFormats] = useState(mode === "convert");
  const [formatsExiting, setFormatsExiting] = useState(false);
  const [settleComplete, setSettleComplete] = useState(false);

  useEffect(() => {
    if (mode === "convert") {
      setFormatsExiting(false);
      setShowFormats(true);
    } else if (showFormats) {
      setFormatsExiting(true);
      const timer = setTimeout(() => {
        setShowFormats(false);
        setFormatsExiting(false);
      }, 250 + 3 * 60); // last button delay + animation duration
      return () => clearTimeout(timer);
    }
  }, [mode]);

  // Guard with a ref instead of state to avoid the stale-closure problem —
  // this way we can always check the latest value inside event handlers.
  const handleDrop = useCallback((paths: string[]) => {
    if (compressingRef.current) return;

    const filtered = paths.filter((p) => {
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      return validExts.includes(ext);
    });

    if (filtered.length === 0) return;

    const files: CompressingFile[] = filtered.map((p) => ({
      path: p,
      name: p.split("/").pop()?.split("\\").pop() ?? p,
      done: false,
    }));

    compressingRef.current = true;
    setCompressingFiles(files);
    setAppState("compressing");

    invoke("compress_images", {
      filePaths: filtered,
      outputFormat: mode === "convert" ? convertFormat : "original",
      quality,
    }).finally(() => {
      compressingRef.current = false;
    });
  }, [mode, convertFormat, quality]);

  // Tauri drag-and-drop events (native, not HTML5 drag events)
  useEffect(() => {
    const unlisten: (() => void)[] = [];

    listen("tauri://drag-enter", () => setIsDragOver(true)).then((u) =>
      unlisten.push(u)
    );
    listen("tauri://drag-leave", () => setIsDragOver(false)).then((u) =>
      unlisten.push(u)
    );
    listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      setIsDragOver(false);
      handleDrop(event.payload.paths);
    }).then((u) => unlisten.push(u));

    return () => unlisten.forEach((u) => u());
  }, [handleDrop]);

  // Backend fires one of these per file as it finishes
  useEffect(() => {
    let cancel: (() => void) | null = null;

    listen<FileProgress>("compression-progress", (event) => {
      const { index } = event.payload;
      setCompressingFiles((prev) =>
        prev.map((f, i) => (i === index ? { ...f, done: true } : f))
      );
    }).then((u) => {
      cancel = u;
    });

    return () => cancel?.();
  }, []);

  // Once every file has reported back, flip to "done" immediately
  // which triggers the settle animation before returning to idle
  useEffect(() => {
    if (
      appState !== "compressing" ||
      compressingFiles.length === 0 ||
      !compressingFiles.every((f) => f.done)
    )
      return;

    setAppState("done");
  }, [appState, compressingFiles]);

  // After all bands finish settling, fade out the overlay then reset to idle
  useEffect(() => {
    if (appState !== "done") {
      setSettleComplete(false);
      return;
    }
    const totalSettleTime = (compressingFiles.length - 1) * 100 + 500;
    const timer = setTimeout(() => setSettleComplete(true), totalSettleTime);
    return () => clearTimeout(timer);
  }, [appState, compressingFiles.length]);

  return (
    <div
      className={`relative h-screen text-gf-text font-display ${supportsTranslucency ? "bg-gf-bg/30 backdrop-blur-xl" : "bg-gf-bg"}`}
    >
      {(appState === "idle" || appState === "done") && (
        <>
          <div
            className={`dot-grid-base absolute inset-0 z-0 transition-opacity duration-500 ${isDragOver ? "opacity-0" : ""}`}
            aria-hidden="true"
          />
          <div
            className={`dot-grid-active-layer absolute inset-0 z-0${isDragOver ? " active" : ""}`}
            aria-hidden="true"
          />
        </>
      )}

      {(appState === "idle" || appState === "done") && (
        <main className="relative z-10 flex h-full items-center px-16 py-12">
          <div className="ghost-in ghost-delay-1 flex flex-col items-start w-full max-w-lg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
              className={`w-12 h-12 mb-6 -ml-1.5 transition-all duration-500 ${isDragOver ? "text-gf-success scale-110" : "text-gf-text"}`}
            >
              <path
                fill="currentColor"
                d="M3.75 3.75H20.25V9H9V20.25H3.75Z"
              />
              <g
                className="transition-transform duration-500"
                style={{ transform: isDragOver ? "translate(-1px, -1px)" : "translate(0, 0)" }}
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 15h4.5M15 15v4.5M15 15l5.25 5.25"
                />
              </g>
            </svg>
            <div>
              <p
                className={`text-lg font-display tracking-tight transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}
              >
                {isDragOver
                  ? mode === "convert" ? "Drop to convert" : "Drop to compress"
                  : mode === "convert" ? "Convert your images" : "Make images lighter"}
              </p>
              <p
                className={`text-xs font-condensed mt-2 tracking-wide transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}
              >
                {isDragOver
                  ? "JPEG, PNG, WebP, AVIF"
                  : "Drop images \u00b7 JPEG, PNG, WebP, AVIF"}
              </p>
            </div>
          </div>
        </main>
      )}

      {(appState === "idle" || appState === "done") && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-10 px-16 pb-10 ghost-in ghost-delay-3 transition-opacity duration-500 ${isDragOver ? "opacity-0" : ""}`}
        >
          <div className="flex items-center gap-3 mb-4">
            <button
              className={`font-condensed text-xs tracking-wide transition-colors duration-300 ${mode === "compress" ? "text-gf-verdigris" : "text-gf-text-secondary"}`}
              onClick={() => setMode("compress")}
            >
              COMPRESS
            </button>
            <button
              className={`font-condensed text-xs tracking-wide transition-colors duration-300 ${mode === "convert" ? "text-gf-verdigris" : "text-gf-text-secondary"}`}
              onClick={() => setMode("convert")}
            >
              CONVERT
            </button>
            {showFormats && (
              <div className="flex items-center gap-2 ml-2">
                {(["jpg", "png", "webp", "avif"] as const).map((fmt, i) => (
                  <button
                    key={fmt}
                    className={`font-condensed text-xs tracking-wide transition-colors duration-300 ${convertFormat === fmt ? "text-gf-verdigris" : "text-gf-text-secondary"}`}
                    style={{
                      animation: formatsExiting
                        ? `fadeOut 250ms ${(3 - i) * 60}ms cubic-bezier(0.16, 1, 0.3, 1) forwards`
                        : `fadeIn 250ms ${i * 60}ms cubic-bezier(0.16, 1, 0.3, 1) forwards`,
                      opacity: formatsExiting ? 1 : 0,
                    }}
                    onClick={() => setConvertFormat(fmt)}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <PixelSlider value={quality} onChange={setQuality} />
            </div>
            <div className="flex flex-col items-end">
              <span className="font-condensed text-xs text-gf-text-secondary">QUALITY</span>
              <span className="font-condensed text-xs text-gf-text-secondary tabular-nums">
                {quality}
              </span>
            </div>
          </div>
        </div>
      )}

      {(appState === "compressing" || appState === "done") && (
        <div
          className="absolute inset-0 z-[5] flex flex-col"
          style={{
            opacity: settleComplete ? 0 : 1,
            transition: settleComplete ? "opacity 0.3s cubic-bezier(0.25, 1, 0.5, 1)" : undefined,
          }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "opacity" && e.currentTarget === e.target && settleComplete) {
              setAppState("idle");
              setCompressingFiles([]);
            }
          }}
        >
          {compressingFiles.map((file, i) => (
            <ProgressBand
              key={file.path}
              file={file}
              index={i}
              totalFiles={compressingFiles.length}
              settling={appState === "done"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
