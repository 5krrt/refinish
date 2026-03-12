import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Window } from "@tauri-apps/api/window";
import DotGrid from "./DotGrid";
import { usePersistedState } from "./usePersistedState";

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
  warning?: string | null;
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
    warning: string | null;
  };
}

async function openSettings() {
  const win = await Window.getByLabel("settings");
  if (win) {
    await win.show();
    await win.setFocus();
  }
}

function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [compressingFiles, setCompressingFiles] = useState<CompressingFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const compressingRef = useRef(false);
  const [quality] = usePersistedState("refinish:quality", 80);
  const [mode] = usePersistedState<"compress" | "convert">("refinish:mode", "compress");
  const [convertFormat] = usePersistedState("refinish:convertFormat", "webp");
  const [scaleFactor] = usePersistedState("refinish:scaleFactor", 0);
  const [settleComplete, setSettleComplete] = useState(false);

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
      scaleFactor,
    }).finally(() => {
      compressingRef.current = false;
    });
  }, [mode, convertFormat, quality, scaleFactor]);

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
      const { index, result } = event.payload;
      setCompressingFiles((prev) =>
        prev.map((f, i) => (i === index ? { ...f, done: true, warning: result.warning } : f))
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
        sliderEl={null}
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
          className={`absolute bottom-0 left-0 right-0 z-10 ghost-in ghost-delay-3 transition-opacity duration-500 ${isDragOver ? "opacity-0" : ""}`}
        >
          <div className="flex items-center justify-between px-5 py-3 bg-gf-surface/60 backdrop-blur-md border-t border-gf-border-subtle">
            <span className="font-condensed text-xs tracking-wide text-gf-text-secondary">
              {mode === "convert"
                ? `Convert to ${convertFormat.toUpperCase()} \u00b7 Quality ${quality}`
                : `Compress \u00b7 Quality ${quality}`}
              {scaleFactor === 1 ? " \u00b7 Original upscale" : scaleFactor > 1 ? ` \u00b7 ${scaleFactor}\u00d7 upscale` : ""}
            </span>
            <button
              onClick={openSettings}
              className="text-gf-text-secondary hover:text-gf-text transition-colors duration-200 p-1 -m-1"
              aria-label="Open settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 0 1 .804.98v1.362a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.294A1 1 0 0 1 1 11.68V10.32a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 4.03l1.25.834a6.957 6.957 0 0 1 1.416-.587l.294-1.473ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" clipRule="evenodd" />
              </svg>
            </button>
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
                {file.warning && (
                  <div className="text-[10px] font-condensed text-gf-text-secondary/70 mt-0.5">
                    {file.warning}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
