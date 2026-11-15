"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ASPECTS, aspectRatio, type Aspect, type Box, type ScanResult } from "@/lib/types";
import { MotionTracker, type Crop } from "@/lib/tracker";
import Editor from "./Editor";
import Gallery, { type Photo } from "./Gallery";

type Phase = "intro" | "starting" | "live" | "error";
type Mode = "idle" | "scanning" | "guiding" | "framing" | "locked" | "lost";
type Facing = "environment" | "user";
type Zoom = { value: number; min: number; max: number; hardware: boolean };
type Tone = "muted" | "guide" | "good";

const DIGITAL_MAX = 4;
const SCAN_LONG_SIDE = 1024;
const CENTER_TOL = 0.05;
const IDLE_HINT = "Tap ✦ to scan a new scene";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scaleBox = (b: Box, r: number): Box => {
  const cx = 0.5 + (b.x + b.w / 2 - 0.5) * r;
  const cy = 0.5 + (b.y + b.h / 2 - 0.5) * r;
  return { x: cx - (b.w * r) / 2, y: cy - (b.h * r) / 2, w: b.w * r, h: b.h * r };
};

export default function CameraCoach() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<MotionTracker | null>(null);
  const modeRef = useRef<Mode>("idle");
  const zoomRef = useRef<Zoom>({ value: 1, min: 1, max: DIGITAL_MAX, hardware: false });
  const anchorRef = useRef<{ box: Box; shift: { x: number; y: number } } | null>(null);
  const currentBoxRef = useRef<Box | null>(null);
  const scanRef = useRef<ScanResult | null>(null);
  const freezeUntil = useRef(0);
  const centeredSince = useRef(0);
  const scanToken = useRef(0);
  const statusRef = useRef("");
  const toastTimer = useRef<number | undefined>(undefined);

  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState("");
  const [facing, setFacing] = useState<Facing>("environment");
  const [aspect, setAspect] = useState<Aspect>("3:4");
  const [vf, setVf] = useState({ w: 0, h: 0 });
  const [zoom, setZoomState] = useState<Zoom>(zoomRef.current);
  const [mode, setModeState] = useState<Mode>("idle");
  const [status, setStatusState] = useState<{ text: string; tone: Tone }>({ text: IDLE_HINT, tone: "muted" });
  const [scan, setScanState] = useState<ScanResult | null>(null);
  const [tilt, setTilt] = useState<number | null>(null);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [toast, setToast] = useState("");
  const [flash, setFlash] = useState(false);
  const [editing, setEditing] = useState<HTMLCanvasElement | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [viewer, setViewer] = useState<number | null>(null);

  const mirror = facing === "user";

  // ---------- small state helpers (refs mirror state for the rAF loop) ----------
  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  };
  const setScan = (s: ScanResult | null) => {
    scanRef.current = s;
    setScanState(s);
  };
  const setStatus = (text: string, tone: Tone) => {
    if (statusRef.current === text + tone) return;
    statusRef.current = text + tone;
    setStatusState({ text, tone });
  };
  const setZoom = (z: Zoom) => {
    zoomRef.current = z;
    setZoomState(z);
  };
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  // ---------- viewfinder sizing ----------
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const a = aspectRatio(aspect);
      const w = Math.min(el.clientWidth, el.clientHeight * a);
      setVf({ w: Math.floor(w), h: Math.floor(w / a) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, phase]);

  useEffect(() => {
    trackerRef.current = new MotionTracker(aspectRatio(aspect));
  }, [aspect]);

  // ---------- camera ----------
  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startCamera = useCallback(async (which: Facing) => {
    setPhase("starting");
    setError("");
    stopStream();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: which }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number }; torch?: boolean };
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        const s = track.getSettings() as MediaTrackSettings & { zoom?: number };
        setZoom({ value: s.zoom ?? caps.zoom.min, min: caps.zoom.min, max: caps.zoom.max, hardware: true });
      } else {
        setZoom({ value: 1, min: 1, max: DIGITAL_MAX, hardware: false });
      }
      setTorch({ supported: !!caps.torch, on: false });
      setPhase("live");
    } catch (e) {
      const name = (e as Error)?.name;
      setError(
        name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access in your browser settings and try again."
          : "Couldn't open the camera. Make sure no other app is using it and that the page is on HTTPS."
      );
      setPhase("error");
    }
  }, []);

  useEffect(() => () => stopStream(), []);

  const onStart = async () => {
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DME?.requestPermission) {
      try {
        await DME.requestPermission();
      } catch {}
    }
    startCamera(facing);
  };

  const flipCamera = () => {
    const next = facing === "environment" ? "user" : "environment";
    cancelScan();
    setFacing(next);
    startCamera(next);
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch.on } as MediaTrackConstraintSet] });
      setTorch((t) => ({ ...t, on: !t.on }));
    } catch {}
  };

  const cycleAspect = () => {
    cancelScan();
    setAspect((a) => ASPECTS[(ASPECTS.indexOf(a) + 1) % ASPECTS.length]);
  };

  // ---------- zoom ----------
  const applyZoom = useCallback(async (target: number) => {
    const z = zoomRef.current;
    const v = Math.min(z.max, Math.max(z.min, target));
    if (z.hardware) {
      try {
        await streamRef.current?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] });
      } catch {}
    }
    setZoom({ ...zoomRef.current, value: v });
    return v;
  }, []);

  const animateZoom = useCallback(
    async (target: number, ms: number, onStep?: (ratio: number) => void) => {
      const from = zoomRef.current.value;
      const to = Math.min(zoomRef.current.max, Math.max(zoomRef.current.min, target));
      const steps = Math.max(1, Math.round(ms / 45));
      for (let i = 1; i <= steps; i++) {
        const e = 1 - Math.pow(1 - i / steps, 3);
        const v = from * Math.pow(to / from, e);
        await applyZoom(v);
        onStep?.(v / from);
        if (!zoomRef.current.hardware) await sleep(ms / steps);
      }
      return to;
    },
    [applyZoom]
  );

  const zoomPresets = (() => {
    const p: number[] = [];
    if (zoom.min < 0.99) p.push(zoom.min);
    p.push(1);
    if (zoom.max >= 2) p.push(2);
    if (zoom.max >= 5) p.push(5);
    else if (zoom.max >= 3) p.push(3);
    return p;
  })();
  const activePreset = zoomPresets.reduce(
    (best, p) => (Math.abs(Math.log(p / zoom.value)) < Math.abs(Math.log(best / zoom.value)) ? p : best),
    zoomPresets[0]
  );
  const fmtZoom = (v: number) => (v < 1 ? `.${Math.round(v * 10)}x` : `${Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)}x`);

  const onPill = async (v: number) => {
    const m = modeRef.current;
    if (m === "scanning" || m === "framing") return;
    const ratio = v / zoomRef.current.value;
    await applyZoom(v);
    if (m === "guiding" && currentBoxRef.current) {
      anchorRef.current = { box: scaleBox(currentBoxRef.current, ratio), shift: { x: 0, y: 0 } };
      trackerRef.current?.reset();
      freezeUntil.current = performance.now() + (zoomRef.current.hardware ? 400 : 60);
      positionBox(anchorRef.current.box);
    }
  };

  // ---------- visible crop (exactly what's in the viewfinder) ----------
  const getCrop = useCallback((): Crop | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.clientWidth) return null;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const cw = v.clientWidth;
    const ch = v.clientHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const digital = zoomRef.current.hardware ? 1 : zoomRef.current.value;
    const sw = cw / scale / digital;
    const sh = ch / scale / digital;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }, []);

  const grab = (longSide: number | null) => {
    const v = videoRef.current;
    const c = getCrop();
    if (!v || !c) return null;
    const k = longSide ? Math.min(1, longSide / Math.max(c.sw, c.sh)) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(c.sw * k);
    canvas.height = Math.round(c.sh * k);
    canvas.getContext("2d")!.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  // ---------- overlay box (direct DOM writes for smooth 30fps updates) ----------
  const positionBox = (b: Box | null) => {
    currentBoxRef.current = b;
    const el = boxRef.current;
    if (!el) return;
    if (!b) {
      el.style.opacity = "0";
      return;
    }
    const left = mirror ? 1 - b.x - b.w : b.x;
    el.style.opacity = "1";
    el.style.left = `${left * 100}%`;
    el.style.top = `${b.y * 100}%`;
    el.style.width = `${b.w * 100}%`;
    el.style.height = `${b.h * 100}%`;
  };

  // ---------- scan flow ----------
  const cancelScan = () => {
    scanToken.current++;
    positionBox(null);
    anchorRef.current = null;
    setScan(null);
    setMode("idle");
    setStatus(IDLE_HINT, "muted");
  };

  const lockShot = (result: ScanResult) => {
    positionBox(null);
    setMode("locked");
    setStatus(result.tip || "Looks great. Take the shot.", "good");
    navigator.vibrate?.(25);
  };

  const frameShot = async (result: ScanResult) => {
    const b = currentBoxRef.current;
    if (!b) return;
    const token = scanToken.current;
    setMode("framing");
    setStatus("Centered — framing up…", "guide");
    navigator.vibrate?.(15);
    await animateZoom(zoomRef.current.value / b.w, 650, (ratio) => positionBox(scaleBox(b, ratio)));
    if (token !== scanToken.current) return;
    setStatus("Framing your shot…", "guide");
    await sleep(350);
    if (token !== scanToken.current) return;
    lockShot(result);
  };

  const startScan = async () => {
    const token = ++scanToken.current;
    setScan(null);
    positionBox(null);
    anchorRef.current = null;
    setMode("scanning");
    setStatus("Finding your shot…", "guide");

    // Always scan from the widest view so Claude has the most to choose from.
    if (zoomRef.current.value > zoomRef.current.min + 0.01) {
      await animateZoom(zoomRef.current.min, 300);
      await sleep(zoomRef.current.hardware ? 350 : 60);
    }
    if (token !== scanToken.current) return;

    const tracker = trackerRef.current;
    const crop = getCrop();
    const frame = grab(SCAN_LONG_SIDE);
    if (!tracker || !crop || !frame) return cancelScan();
    tracker.reset();
    tracker.update(videoRef.current!, crop); // reference = the exact frame Claude sees
    freezeUntil.current = 0;

    try {
      const z = zoomRef.current;
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: frame.toDataURL("image/jpeg", 0.82).split(",")[1],
          aspect,
          zoom: z.value,
          maxZoomRatio: z.max / z.value,
          camera: mirror ? "front" : "back",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Scan failed");
      if (token !== scanToken.current) return;
      const result = data as ScanResult;
      setScan(result);

      if (result.box.w >= 0.92) return lockShot(result); // the whole frame is already the shot
      anchorRef.current = { box: result.box, shift: { x: 0, y: 0 } };
      centeredSince.current = 0;
      setMode("guiding");
    } catch (e) {
      if (token !== scanToken.current) return;
      showToast((e as Error).message || "Scan failed");
      cancelScan();
    }
  };

  const onSparkle = () => {
    const m = modeRef.current;
    if (m === "scanning" || m === "guiding" || m === "framing") cancelScan();
    else startScan();
  };

  // ---------- tracking loop: keeps the box pinned to the scene ----------
  const frameShotRef = useRef(frameShot);
  frameShotRef.current = frameShot;
  const positionRef = useRef(positionBox);
  positionRef.current = positionBox;

  useEffect(() => {
    if (mode !== "scanning" && mode !== "guiding") return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 33) return;
      last = now;
      const m = modeRef.current;
      if (m !== "scanning" && m !== "guiding") return;
      const tracker = trackerRef.current;
      const crop = getCrop();
      if (!tracker || !crop || now < freezeUntil.current) return;
      const shift = tracker.update(videoRef.current!, crop);
      const a = anchorRef.current;
      if (m !== "guiding" || !a) return;

      const b: Box = { ...a.box, x: a.box.x + shift.x - a.shift.x, y: a.box.y + shift.y - a.shift.y };
      positionRef.current(b);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (cx < -0.3 || cx > 1.3 || cy < -0.3 || cy > 1.3) {
        positionRef.current(null);
        setMode("lost");
        setStatus("Lost the shot. Tap ↻ to rescan", "muted");
        return;
      }
      const dx = cx - 0.5;
      const dy = cy - 0.5;
      if (Math.abs(dx) < CENTER_TOL && Math.abs(dy) < CENTER_TOL) {
        if (!centeredSince.current) centeredSince.current = now;
        setStatus("Hold steady…", "guide");
        if (now - centeredSince.current > 300 && scanRef.current) frameShotRef.current(scanRef.current);
        return;
      }
      centeredSince.current = 0;
      const vSign = mirror ? -1 : 1;
      const h = Math.abs(dx) >= CENTER_TOL ? (dx > 0 ? "right" : "left") : "";
      const v = Math.abs(dy) >= CENTER_TOL ? (dy * vSign < 0 ? "up" : "down") : "";
      const dir =
        Math.abs(dx) > Math.abs(dy) * 2 || !v ? h : Math.abs(dy) > Math.abs(dx) * 2 || !h ? v : `${v} and ${h}`;
      setStatus(`Move your phone ${dir}`, "guide");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, getCrop, mirror]);

  // ---------- horizon level ----------
  useEffect(() => {
    if (phase !== "live") return;
    let smooth: number | null = null;
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null || g.z == null) return;
      const planar = Math.hypot(g.x, g.y);
      const total = Math.hypot(g.x, g.y, g.z);
      if (!total || planar / total < 0.5) return setTilt(null);
      const deg = (Math.atan2(g.x, g.y) * 180) / Math.PI;
      const rel = ((((deg % 90) + 135) % 90) + 90) % 90 - 45;
      smooth = smooth == null ? rel : smooth * 0.8 + rel * 0.2;
      setTilt(Math.round(smooth * 10) / 10);
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [phase]);

  // ---------- capture ----------
  const onShutter = () => {
    let canvas = grab(null);
    if (!canvas) return;
    // Digital zoom crops the sensor image; upscale small captures so saved photos aren't tiny.
    const long = Math.max(canvas.width, canvas.height);
    if (long < 2048) {
      const k = 2048 / long;
      const up = document.createElement("canvas");
      up.width = Math.round(canvas.width * k);
      up.height = Math.round(canvas.height * k);
      const ctx = up.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, up.width, up.height);
      canvas = up;
    }
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    navigator.vibrate?.(10);
    setEditing(canvas);
  };

  const onSaved = async (blob: Blob) => {
    const photo: Photo = { id: crypto.randomUUID(), url: URL.createObjectURL(blob), blob, date: new Date() };
    setPhotos((p) => [photo, ...p]);
    setEditing(null);
    await savePhoto(photo, showToast);
  };

  // ---------- render ----------
  const level = tilt != null && Math.abs(tilt) < 1.2;
  const digitalScale = zoom.hardware ? 1 : zoom.value;
  const busy = mode === "scanning" || mode === "guiding" || mode === "framing";

  return (
    <main className="app">
      <header className="top">
        <button className="aspect-btn" onClick={cycleAspect} disabled={phase !== "live"}>
          <span className={`aspect-icon a${aspect.replace(":", "")}`} /> {aspect} <i>⌄</i>
        </button>
        <div className="top-right">
          {torch.supported && (
            <button className={`top-icon ${torch.on ? "on" : ""}`} onClick={toggleTorch} aria-label="Flashlight">
              <BoltIcon />
            </button>
          )}
          <button className="top-icon" onClick={flipCamera} aria-label="Flip camera" disabled={phase !== "live"}>
            <FlipIcon />
          </button>
        </div>
      </header>

      <div className="vf-wrap" ref={wrapRef}>
        <div className={`vf ${mode === "scanning" ? "scanning" : ""}`} style={{ width: vf.w, height: vf.h }}>
          <video
            ref={videoRef}
            className="video"
            playsInline
            muted
            autoPlay
            style={{ transform: `${mirror ? "scaleX(-1) " : ""}scale(${digitalScale})` }}
          />
          {phase === "live" && (
            <>
              <div className="grid" aria-hidden>
                <i style={{ left: "33.333%" }} />
                <i style={{ left: "66.666%" }} />
                <b style={{ top: "33.333%" }} />
                <b style={{ top: "66.666%" }} />
              </div>

              <div className={`level ${level ? "ok" : ""} ${tilt == null ? "off" : ""}`} aria-hidden>
                <span className="line" style={{ transform: `rotate(${tilt ?? 0}deg)` }} />
                <span className="dot" />
              </div>

              <div className="shot-box" ref={boxRef} style={{ opacity: 0 }}>
                {scan && mode !== "framing" && <span className="shot-label">{scan.label}</span>}
              </div>

              {mode === "locked" && scan && (
                <button className="chip" onClick={() => showToast(scan.why)}>
                  <span className="chip-dot" /> {scan.label}
                </button>
              )}
              {flash && <div className="flash" />}
            </>
          )}
        </div>
      </div>

      <div className="hud">
        <p className={`status ${status.tone}`}>{phase === "live" ? status.text : " "}</p>

        <div className="zooms">
          {zoomPresets.map((p) => {
            const active = p === activePreset;
            return (
              <button
                key={p}
                className={`zoom ${active ? "active" : ""}`}
                onClick={() => onPill(p)}
                disabled={phase !== "live" || mode === "scanning" || mode === "framing"}
              >
                {active ? fmtZoom(zoom.value) : fmtZoom(p)}
              </button>
            );
          })}
        </div>

        <div className="controls">
          <button className="thumb" onClick={() => photos.length && setViewer(0)} aria-label="Open gallery">
            {photos[0] ? <img src={photos[0].url} alt="" /> : <span />}
          </button>
          <button className="shutter" onClick={onShutter} disabled={phase !== "live"} aria-label="Take photo">
            <span />
          </button>
          <button
            className={`spark ${busy ? "cancel" : mode === "locked" || mode === "lost" ? "again" : ""}`}
            onClick={onSparkle}
            disabled={phase !== "live"}
            aria-label={busy ? "Cancel" : "Scan scene"}
          >
            {busy ? <CloseIcon /> : mode === "locked" || mode === "lost" ? <RefreshIcon /> : <SparkIcon />}
          </button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {editing && (
        <Editor source={editing} suggested={scan?.look ?? "clean"} aiPicked={!!scan} onSave={onSaved} onDelete={() => setEditing(null)} />
      )}
      {viewer != null && photos.length > 0 && (
        <Gallery
          photos={photos}
          start={viewer}
          onClose={() => setViewer(null)}
          onDelete={(id) => setPhotos((p) => p.filter((x) => x.id !== id))}
          onSave={(p) => savePhoto(p, showToast)}
        />
      )}

      {phase !== "live" && (
        <div className="intro">
          <div className="intro-inner">
            <div className="logo">
              <SparkIcon />
            </div>
            <h1>
              Frame<span>Coach</span>
            </h1>
            <p>
              Tap <b>✦</b> and Claude finds the best shot in your scene, guides your phone to it and zooms in. You just press the shutter.
            </p>
            {phase === "error" && <p className="err">{error}</p>}
            <button className="start-btn" onClick={onStart} disabled={phase === "starting"}>
              {phase === "starting" ? "Opening camera…" : phase === "error" ? "Try again" : "Start camera"}
            </button>
            <small>A frame is sent to Claude only when you tap ✦.</small>
          </div>
        </div>
      )}
    </main>
  );
}

async function savePhoto(photo: Photo, toast: (m: string) => void) {
  const file = new File([photo.blob], `framecoach-${photo.date.getTime()}.jpg`, { type: "image/jpeg" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = photo.url;
  a.download = file.name;
  a.click();
  toast("Saved to downloads");
}

// ---------- icons ----------
export function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
      <path d="M11 2.5l1.9 5.6 5.6 1.9-5.6 1.9L11 17.5l-1.9-5.6L3.5 10l5.6-1.9L11 2.5z" />
      <path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" opacity=".85" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}
function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9a8 8 0 0 1 14.5-3.5L20 7M20 15a8 8 0 0 1-14.5 3.5L4 17" />
      <path d="M20 3v4h-4M4 21v-4h4" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
