import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import DotGrid from "./DotGrid";

const validExts = ["jpg", "jpeg", "png", "webp", "avif"];

const supportsTranslucency = (() => {
  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  if (nav.userAgentData?.platform) {
    const p = nav.userAgentData.platform;
    return p === "macOS" || p === "Windows";
  }
  return /Mac|Win/.test(navigator.platform);
})();

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

function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [compressingFiles, setCompressingFiles] = useState<CompressingFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const compressingRef = useRef(false);
  const [quality, setQuality] = usePersistedState("refinish:quality", 80);
  const [mode, setMode] = usePersistedState<"compress" | "convert">("refinish:mode", "compress");
  const [convertFormat, setConvertFormat] = usePersistedState("refinish:convertFormat", "webp");
  const [showFormats, setShowFormats] = useState(mode === "convert");
  const [formatsExiting, setFormatsExiting] = useState(false);
  const [settleComplete, setSettleComplete] = useState(false);

  // Slider ref — DotGrid reads bounds live from this element each frame
  const sliderRef = useRef<HTMLDivElement>(null);
  const [sliderEl, setSliderEl] = useState<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setSliderEl(sliderRef.current);
  }, []);

  // Slider mouse interaction
  const valueFromX = useCallback(
    (clientX: number) => {
      const el = sliderRef.current;
      if (!el) return quality;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(50 + ratio * 50);
    },
    [quality]
  );

  const handleSliderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      setQuality(valueFromX(e.clientX));

      const onMove = (ev: MouseEvent) => {
        if (draggingRef.current) setQuality(valueFromX(ev.clientX));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setQuality, valueFromX]
  );

  useEffect(() => {
    if (mode === "convert") {
      setFormatsExiting(false);
      setShowFormats(true);
    } else if (showFormats) {
      setFormatsExiting(true);
      const timer = setTimeout(() => {
        setShowFormats(false);
        setFormatsExiting(false);
      }, 250 + 3 * 60);
      return () => clearTimeout(timer);
    }
  }, [mode]);

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

  useEffect(() => {
    if (
      appState !== "compressing" ||
      compressingFiles.length === 0 ||
      !compressingFiles.every((f) => f.done)
    )
      return;

    setAppState("done");
  }, [appState, compressingFiles]);

  useEffect(() => {
    if (appState !== "done") {
      setSettleComplete(false);
      return;
    }
  }, [appState]);

  const handleSettleComplete = useCallback(() => {
    setSettleComplete(true);
  }, []);

  return (
    <div
      className={`relative h-screen text-gf-text font-display ${supportsTranslucency ? "bg-gf-bg/30 backdrop-blur-xl" : "bg-gf-bg"}`}
    >
      <DotGrid
        appState={appState}
        isDragOver={isDragOver}
        files={compressingFiles}
        sliderEl={sliderEl}
        quality={quality}
        settleComplete={settleComplete}
        onSettleComplete={handleSettleComplete}
      />

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
              <div
                ref={sliderRef}
                className="cursor-pointer select-none"
                style={{ height: 32 }}
                onMouseDown={handleSliderMouseDown}
              />
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
          className="absolute inset-0 z-10 flex flex-col pointer-events-none"
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
          {compressingFiles.map((file) => (
            <div
              key={file.path}
              className="relative"
              style={{ height: `${100 / compressingFiles.length}%` }}
            >
              <div
                className="absolute bottom-3 left-4 text-sm text-gf-text font-condensed font-medium pointer-events-none"
                style={{
                  textShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  opacity: appState === "done" ? 0 : undefined,
                  transition: appState === "done" ? 'opacity 0.4s cubic-bezier(0.25, 1, 0.5, 1)' : undefined,
                }}
              >
                {file.name}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
