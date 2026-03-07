import { useState, useEffect, useRef, useCallback } from "react";
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

// Fakes a progress bar that eases toward ~95% using an exponential curve,
// then snaps to 100% once the backend signals completion. This way the user
// sees immediate feedback instead of a frozen bar while waiting on the real work.
function useSimulatedProgress(isDone: boolean): number {
  const [progress, setProgress] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (isDone) {
      setProgress(1);
      cancelAnimationFrame(rafRef.current);
      return;
    }

    startRef.current = performance.now();

    function tick() {
      const elapsed = performance.now() - startRef.current!;
      const t = elapsed / 5000;
      // 1 - e^(-3t) gives a nice fast-start-slow-finish feel, capped at 95%
      setProgress(Math.min(0.95, 1 - Math.exp(-3 * t)));
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isDone]);

  return progress;
}

// Each file gets a horizontal band filled with a dot grid. Columns light up
// in verdigris as progress fills left-to-right, then sweep back to neutral
// when compression finishes (the "settle" effect).
function ProgressBand({
  file,
  totalFiles,
  settling,
}: {
  file: CompressingFile;
  totalFiles: number;
  settling: boolean;
}) {
  const progress = useSimulatedProgress(file.done);
  const containerRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState({ cols: 0, rows: 0 });
  const [settleProgress, setSettleProgress] = useState<number | null>(null);

  // Figure out how many dots fit in the container — recalculates on resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const cell = 7; // 4px block + 3px gap
      setGrid({
        cols: Math.floor(width / cell),
        rows: Math.floor(height / cell),
      });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Settle animation: sweeps left-to-right fading verdigris blocks back to neutral
  useEffect(() => {
    if (!settling) {
      setSettleProgress(null);
      return;
    }
    const start = performance.now();
    let raf: number;
    function tick() {
      const elapsed = performance.now() - start;
      const t = Math.min(1, elapsed / 1200);
      setSettleProgress(1 - Math.pow(1 - t, 3));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settling]);

  const totalBlocks = grid.cols * grid.rows;
  const filledCols = Math.round(progress * grid.cols);
  const settledCols = settleProgress !== null
    ? Math.round(settleProgress * grid.cols)
    : 0;

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden"
      style={{ height: `${100 / totalFiles}%` }}
    >
      {totalBlocks > 0 && (
        <div
          className="grid w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${grid.cols}, 4px)`,
            gridTemplateRows: `repeat(${grid.rows}, 4px)`,
            gap: "3px",
            justifyContent: "center",
            alignContent: "center",
          }}
        >
          {Array.from({ length: totalBlocks }, (_, i) => {
            const col = i % grid.cols;
            const filled = col < filledCols;
            const settled = settling && col < settledCols;
            const t = col / (grid.cols - 1 || 1);
            return (
              <div
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 1,
                  backgroundColor: filled
                    ? "var(--color-gf-verdigris)"
                    : "var(--color-gf-surface-2)",
                  opacity: settled ? 0 : filled ? t : 1,
                }}
              />
            );
          })}
        </div>
      )}
      <div
        className="absolute bottom-3 left-4 text-sm text-gf-text font-condensed font-medium pointer-events-none"
        style={{
          textShadow: '0 1px 3px rgba(0,0,0,0.5)',
          opacity: settling ? 0 : undefined,
          transition: settling ? 'opacity 0.6s cubic-bezier(0.25, 1, 0.5, 1)' : undefined,
        }}
      >
        {file.name}
      </div>
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
      outputFormat: "original",
    }).finally(() => {
      compressingRef.current = false;
    });
  }, []);

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

  // Once every file has reported back, hold for a second then flip to "done"
  // which triggers the settle animation before returning to idle
  useEffect(() => {
    if (
      appState !== "compressing" ||
      compressingFiles.length === 0 ||
      !compressingFiles.every((f) => f.done)
    )
      return;

    const timer = setTimeout(() => {
      setAppState("done");
    }, 1000);

    return () => clearTimeout(timer);
  }, [appState, compressingFiles]);

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
              className={`w-12 h-12 mb-6 transition-all duration-500 ${isDragOver ? "text-gf-success scale-110" : "text-gf-text"}`}
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
            <p
              className={`text-lg font-display tracking-tight transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}
            >
              {isDragOver ? "Drop to compress" : "Make images lighter"}
            </p>
            <p
              className={`text-xs font-condensed mt-2 tracking-wide transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}
            >
              {isDragOver
                ? "JPEG, PNG, WebP, AVIF"
                : "Drop images \u00b7 JPEG, PNG, WebP, AVIF"}
            </p>
          </div>
        </main>
      )}

      {(appState === "compressing" || appState === "done") && (
        <div
          className={`absolute inset-0 z-[5] flex flex-col ${appState === "done" ? "compress-settle" : ""}`}
          onAnimationEnd={() => {
            if (appState === "done") {
              setAppState("idle");
              setCompressingFiles([]);
            }
          }}
        >
          {compressingFiles.map((file) => (
            <ProgressBand
              key={file.path}
              file={file}
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
