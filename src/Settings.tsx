import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import DotGrid from "./DotGrid";
import { usePersistedState } from "./usePersistedState";

const supportsTranslucency = (() => {
  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  if (nav.userAgentData?.platform) {
    const p = nav.userAgentData.platform;
    return p === "macOS" || p === "Windows";
  }
  return /Mac|Win/.test(navigator.platform);
})();

function Settings() {
  const [quality, setQuality] = usePersistedState("refinish:quality", 80);
  const [mode, setMode] = usePersistedState<"compress" | "convert">("refinish:mode", "compress");
  const [convertFormat, setConvertFormat] = usePersistedState("refinish:convertFormat", "webp");
  const [scaleFactor, setScaleFactor] = usePersistedState("refinish:scaleFactor", 0);
  const [showFormats, setShowFormats] = useState(mode === "convert");
  const [formatsExiting, setFormatsExiting] = useState(false);

  const sliderRef = useRef<HTMLDivElement>(null);
  const [sliderEl, setSliderEl] = useState<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    setSliderEl(sliderRef.current);
  }, []);

  // Hide window instead of closing so it can be re-shown
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlisten = win.onCloseRequested(async (e) => {
      e.preventDefault();
      await win.hide();
    });
    return () => { unlisten.then((u) => u()); };
  }, []);

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

  return (
    <div
      className={`relative h-screen text-gf-text font-display ${supportsTranslucency ? "bg-gf-bg/30 backdrop-blur-xl" : "bg-gf-bg"}`}
    >
      <DotGrid
        appState="idle"
        isDragOver={false}
        files={[]}
        sliderEl={sliderEl}
        quality={quality}
        settleComplete={false}
        onSettleComplete={() => {}}
      />

      <div className="relative z-10 flex flex-col justify-end h-full px-12 pb-8 pt-10">
        <div className="flex items-center gap-5 mb-5">
          {([
            { label: "1\u00d7", factor: 0, size: 7 },
            { label: "2\u00d7", factor: 2, size: 12 },
            { label: "4\u00d7", factor: 4, size: 18 },
            { label: "8\u00d7", factor: 8, size: 26 },
          ] as const).map(({ label, factor, size }) => {
            const active = scaleFactor === factor;
            return (
              <button
                key={factor}
                className="group flex flex-col items-center gap-2 cursor-pointer"
                onClick={() => setScaleFactor(factor)}
              >
                <div
                  className={`rounded-sm transition-all duration-300 ${active ? "border-gf-verdigris bg-gf-verdigris/20" : "border-gf-border-subtle group-hover:border-gf-text-secondary"} border`}
                  style={{ width: size, height: size }}
                />
                <span className={`font-condensed text-[10px] tracking-wide transition-colors duration-300 ${active ? "text-gf-verdigris" : "text-gf-text-secondary"}`}>
                  {label}
                </span>
              </button>
            );
          })}
          <span className="font-condensed text-xs tracking-wide text-gf-text-secondary ml-auto">SCALE</span>
        </div>
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
    </div>
  );
}

export default Settings;
