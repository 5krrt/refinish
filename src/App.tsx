import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface ImageFile {
  path: string;
  name: string;
}

interface CompressionResult {
  path: string;
  name: string;
  originalSize: number;
  compressedSize: number;
  savingsPercent: number;
  success: boolean;
  error: string | null;
}

const validExts = ["jpg", "jpeg", "png", "webp", "avif"];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

const supportsTranslucency = (() => {
  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  if (nav.userAgentData?.platform) {
    const p = nav.userAgentData.platform;
    return p === "macOS" || p === "Windows";
  }
  return /Mac|Win/.test(navigator.platform);
})();

function Spinner({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <svg
      className={`${size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4"} animate-spin`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75" />
    </svg>
  );
}

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gf-accent focus-visible:ring-offset-2 focus-visible:ring-offset-gf-bg";

function App() {
  const [files, setFiles] = useState<ImageFile[]>([]);
  const [results, setResults] = useState<CompressionResult[]>([]);
  const [compressingIndex, setCompressingIndex] = useState<number | null>(null);
  const compressingRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [outputFormat, setOutputFormat] = useState<string>("original");

  const addFiles = useCallback(
    (paths: string[]) => {
      if (compressingRef.current) return;
      const newFiles: ImageFile[] = paths
        .filter((p) => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return validExts.includes(ext);
        })
        .map((p) => ({
          path: p,
          name: p.split("/").pop()?.split("\\").pop() ?? p,
        }));

      if (newFiles.length > 0) {
        setFiles((prev) => {
          const existing = new Set(prev.map((f) => f.path));
          return [...prev, ...newFiles.filter((f) => !existing.has(f.path))];
        });
        setResults([]);
      }
    },
    []
  );

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
      addFiles(event.payload.paths);
    }).then((u) => unlisten.push(u));

    return () => unlisten.forEach((u) => u());
  }, [addFiles]);

  async function handleCompress() {
    compressingRef.current = true;
    setResults([]);
    setCompressingIndex(0);
    try {
      const res = await invoke<CompressionResult[]>("compress_images", {
        filePaths: files.map((f) => f.path),
        outputFormat: outputFormat,
      });
      setResults(res);
    } catch {
      setResults(
        files.map((f) => ({
          path: f.path,
          name: f.name,
          originalSize: 0,
          compressedSize: 0,
          savingsPercent: 0,
          success: false,
          error: "Compression failed",
        }))
      );
    }
    setCompressingIndex(null);
    compressingRef.current = false;
    setFiles([]);
  }

  function handleClear() {
    setFiles([]);
    setResults([]);
    setOutputFormat("original");
  }

  const hasFiles = files.length > 0;
  const hasResults = results.length > 0;

  const totalOriginal = results.reduce((s, r) => s + r.originalSize, 0);
  const totalCompressed = results.reduce((s, r) => s + r.compressedSize, 0);
  const totalSavings =
    totalOriginal > 0
      ? ((1 - totalCompressed / totalOriginal) * 100).toFixed(1)
      : "0.0";

  return (
    <div
      className={`relative h-screen text-gf-text font-display ${supportsTranslucency ? "bg-gf-bg/30 backdrop-blur-xl" : "bg-gf-bg"}`}
    >
      <header className="absolute top-0 right-0 flex items-center justify-end px-6 h-14 z-10">
        {hasFiles && !hasResults && compressingIndex === null ? (
          <div
            role="radiogroup"
            aria-label="Output format"
            className="flex items-center gap-0.5 bg-gf-surface-2 rounded-lg p-0.5"
          >
            {["original", "webp", "avif"].map((fmt) => (
              <button
                key={fmt}
                role="radio"
                aria-checked={outputFormat === fmt}
                onClick={() => setOutputFormat(fmt)}
                className={`px-4 py-2 text-sm rounded-md transition-all duration-200 ${focusRing} ${
                  outputFormat === fmt
                    ? "bg-gf-surface-3 text-gf-text"
                    : "text-gf-text-tertiary hover:text-gf-text-secondary"
                }`}
              >
                {fmt === "original" ? "Original" : fmt.toUpperCase()}
              </button>
            ))}
          </div>
        ) : (outputFormat !== "original" && (hasFiles || hasResults)) ? (
          <span className="text-xs font-medium text-gf-text-tertiary bg-gf-surface-2 px-3 py-1.5 rounded-lg">
            {outputFormat.toUpperCase()}
          </span>
        ) : null}
      </header>

      {!hasFiles && !hasResults && (
        <>
          <div className={`dot-grid-base absolute inset-0 z-0 transition-opacity duration-500 ${isDragOver ? "opacity-0" : ""}`} aria-hidden="true" />
          <div className={`dot-grid-active-layer absolute inset-0 z-0${isDragOver ? " active" : ""}`} aria-hidden="true" />
        </>
      )}

      <main className="relative z-10 flex h-full items-center px-16 py-12">
        {/* Empty / Drop zone */}
        {!hasFiles && !hasResults && (
          <div
            className="ghost-in ghost-delay-1 flex flex-col items-start w-full max-w-lg"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1}
              stroke="currentColor"
              aria-hidden="true"
              className={`w-12 h-12 mb-6 transition-all duration-500 ${isDragOver ? "text-gf-success scale-110" : "text-gf-text"}`}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
              />
            </svg>
            <p
              className={`text-lg font-medium tracking-tight transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}
            >
              {isDragOver ? "Drop to compress" : "Make images lighter"}
            </p>
            <p className={`text-xs mt-2 tracking-wide transition-all duration-500 ${isDragOver ? "text-gf-success" : "text-gf-text"}`}>
              {isDragOver ? "JPEG, PNG, WebP, AVIF" : "Drop images \u00b7 JPEG, PNG, WebP, AVIF"}
            </p>
          </div>
        )}

        {/* File list (pre/during compression) */}
        {hasFiles && (
          <div className="w-full max-w-lg ghost-in ghost-delay-1">
            <ul className="rounded-2xl border border-gf-border-subtle overflow-hidden">
              {files.map((f, i) => {
                const result = results[i];
                const isActive = compressingIndex !== null;
                return (
                  <li
                    key={f.path}
                    className={`ghost-in flex items-center justify-between px-5 py-3.5 ${
                      i > 0 ? "border-t border-gf-border-subtle" : ""
                    }`}
                    style={{ animationDelay: `${0.1 + i * 0.08}s` }}
                  >
                    <span className="text-sm truncate mr-6 text-gf-text-secondary">
                      {f.name}
                    </span>
                    {result ? (
                      result.success ? (
                        <span className="flex items-center gap-4 shrink-0">
                          <span className="font-mono text-xs text-gf-text-tertiary tabular-nums">
                            {formatBytes(result.originalSize)} &rarr;{" "}
                            {formatBytes(result.compressedSize)}
                          </span>
                          <span
                            className={`font-mono text-sm font-semibold tabular-nums ${
                              result.savingsPercent > 20
                                ? "text-gf-success"
                                : result.savingsPercent > 0
                                  ? "text-gf-text-secondary"
                                  : "text-gf-text-tertiary"
                            }`}
                          >
                            {result.savingsPercent > 0
                              ? `-${result.savingsPercent.toFixed(1)}%`
                              : "0%"}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-gf-error shrink-0">
                          {result.error ?? "Failed"}
                        </span>
                      )
                    ) : isActive ? (
                      <span
                        role="status"
                        aria-label="Compressing"
                        className="flex items-center gap-2 text-xs text-gf-text-tertiary shrink-0"
                      >
                        <Spinner size="sm" />
                        Compressing
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center gap-3 mt-6">
              {compressingIndex !== null ? (
                <span
                  role="status"
                  aria-label={`Compressing ${files.length} ${files.length === 1 ? "file" : "files"}`}
                  className="px-5 py-2.5 text-sm text-gf-text-tertiary flex items-center gap-2.5"
                >
                  <Spinner size="md" />
                  Compressing {files.length} {files.length === 1 ? "file" : "files"}
                </span>
              ) : (
                <button
                  onClick={handleCompress}
                  className={`px-5 py-2.5 text-sm font-medium rounded-xl bg-gf-accent text-gf-accent-text hover:bg-gf-accent-hover active:bg-gf-accent transition-all duration-200 ${focusRing}`}
                >
                  {outputFormat !== "original"
                    ? `Convert to ${outputFormat.toUpperCase()}`
                    : "Compress"}
                </button>
              )}
              <button
                onClick={handleClear}
                disabled={compressingIndex !== null}
                className={`px-5 py-2.5 text-sm rounded-xl text-gf-text-tertiary hover:text-gf-text-secondary hover:bg-gf-surface-2 disabled:opacity-30 transition-all duration-300 ${focusRing}`}
              >
                Clear
              </button>
            </div>

            {compressingIndex === null && (
              <p className="text-xs text-gf-text-disabled mt-4">
                Drop more to add
              </p>
            )}
          </div>
        )}

        {/* Results */}
        {!hasFiles && hasResults && (
          <div
            className="w-full max-w-lg ghost-in ghost-delay-1"
            aria-live="polite"
          >
            <div className="mb-6 ghost-in ghost-delay-1">
              <p className={`text-4xl font-bold tracking-tight tabular-nums font-mono ${
                Number(totalSavings) > 20 ? "text-gf-success"
                : Number(totalSavings) > 0 ? "text-gf-text-secondary"
                : "text-gf-text-tertiary"
              }`}>
                {Number(totalSavings) > 0 ? `-${totalSavings}%` : "0%"}
              </p>
              <p className="text-sm text-gf-text-tertiary mt-1">
                Saved {formatBytes(totalOriginal - totalCompressed)}
                {outputFormat !== "original" && ` \u00b7 Converted to ${outputFormat.toUpperCase()}`}
              </p>
            </div>
            <div className="rounded-2xl border border-gf-border-subtle overflow-hidden">
              <ul>
                {results.map((r, i) => (
                  <li
                    key={r.path}
                    className={`ghost-in flex items-center justify-between px-5 py-3.5 ${
                      i > 0 ? "border-t border-gf-border-subtle" : ""
                    }`}
                    style={{ animationDelay: `${0.1 + i * 0.08}s` }}
                  >
                    <span className="text-sm text-gf-text-secondary truncate mr-6">
                      {r.name}
                    </span>
                    {r.success ? (
                      <span className="flex items-center gap-4 shrink-0">
                        <span className="font-mono text-xs text-gf-text-tertiary tabular-nums">
                          {formatBytes(r.originalSize)} &rarr;{" "}
                          {formatBytes(r.compressedSize)}
                        </span>
                        <span
                          className={`font-mono text-sm font-semibold tabular-nums ${
                            r.savingsPercent > 20
                              ? "text-gf-success"
                              : r.savingsPercent > 0
                                ? "text-gf-text-secondary"
                                : "text-gf-text-tertiary"
                          }`}
                        >
                          {r.savingsPercent > 0
                            ? `-${r.savingsPercent.toFixed(1)}%`
                            : "0%"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-gf-error shrink-0">
                        {r.error ?? "Failed"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between px-5 py-4 border-t border-gf-border">
                <span className="text-sm font-medium text-gf-text-secondary">
                  {results.length} {results.length === 1 ? "file" : "files"}
                </span>
                <span className="font-mono text-xs text-gf-text-tertiary tabular-nums">
                  {formatBytes(totalOriginal)} &rarr; {formatBytes(totalCompressed)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3 mt-6 ghost-in ghost-delay-3">
              <button
                onClick={handleClear}
                className={`px-5 py-2.5 text-sm font-medium rounded-xl bg-gf-accent text-gf-accent-text hover:bg-gf-accent-hover active:bg-gf-accent transition-all duration-200 ${focusRing}`}
              >
                Compress more
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
