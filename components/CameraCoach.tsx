"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MOVE_LABELS, type Coaching } from "@/lib/types";

type Phase = "intro" | "starting" | "live" | "error";
type Facing = "environment" | "user";
type ZoomState = { value: number; min: number; max: number; hardware: boolean };

const DIGITAL_MAX_ZOOM = 4;
const COACH_LONG_SIDE = 1024; // px sent to Claude
const PREVIOUS_TTL_MS = 3 * 60 * 1000; // follow-up checks stay "the same shot" for 3 minutes

export default function CameraCoach() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastCoachAt = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);

  const [phase, setPhase] = useState<Phase>("intro");
  const [error, setError] = useState("");
  const [facing, setFacing] = useState<Facing>("environment");
  const [zoom, setZoom] = useState<ZoomState>({ value: 1, min: 1, max: DIGITAL_MAX_ZOOM, hardware: false });
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [muted, setMuted] = useState(false);
  const [tilt, setTilt] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // ---------- helpers ----------
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (muted || typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    },
    [muted]
  );

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
        video: { facingMode: { ideal: which }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Hardware zoom (Android Chrome) if available, otherwise digital crop zoom.
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
        setZoom({ value: settings.zoom ?? caps.zoom.min, min: caps.zoom.min, max: caps.zoom.max, hardware: true });
      } else {
        setZoom({ value: 1, min: 1, max: DIGITAL_MAX_ZOOM, hardware: false });
      }
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
    // iOS needs motion permission + a speech "unlock" from a user gesture.
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (DME?.requestPermission) {
      try {
        await DME.requestPermission();
      } catch {}
    }
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    startCamera(facing);
  };

  const flipCamera = () => {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    setCoaching(null);
    startCamera(next);
  };

  const applyZoom = useCallback(
    async (target: number) => {
      const clamped = Math.min(zoom.max, Math.max(zoom.min, target));
      if (zoom.hardware) {
        const track = streamRef.current?.getVideoTracks()[0];
        try {
          await track?.applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] });
        } catch {}
      }
      setZoom((z) => ({ ...z, value: clamped }));
      return clamped;
    },
    [zoom]
  );

  const cycleZoom = () => {
    const presets = Array.from(new Set([zoom.min, 1, 2, 3]))
      .filter((p) => p >= zoom.min && p <= zoom.max)
      .sort((a, b) => a - b);
    const idx = presets.findIndex((p) => Math.abs(p - zoom.value) < 0.05);
    applyZoom(presets[(idx + 1) % presets.length] ?? zoom.min);
  };

  // ---------- horizon level (gravity from accelerometer) ----------
  useEffect(() => {
    if (phase !== "live") return;
    let smooth: number | null = null;
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null || g.z == null) return;
      const planar = Math.hypot(g.x, g.y);
      const total = Math.hypot(g.x, g.y, g.z);
      if (total === 0 || planar / total < 0.5) {
        setTilt(null); // phone pointing at floor/sky — level doesn't apply
        return;
      }
      const deg = (Math.atan2(g.x, g.y) * 180) / Math.PI;
      const rel = ((((deg % 90) + 135) % 90) + 90) % 90 - 45; // nearest 90° → works in portrait + landscape, iOS + Android
      smooth = smooth == null ? rel : smooth * 0.8 + rel * 0.2;
      setTilt(Math.round(smooth * 10) / 10);
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [phase]);

  // ---------- frame capture (exactly what's visible on screen) ----------
  const grabFrame = useCallback(
    (longSide: number | null, quality: number) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return null;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = video.clientWidth;
      const ch = video.clientHeight;
      const scale = Math.max(cw / vw, ch / vh); // object-fit: cover
      const digital = zoom.hardware ? 1 : zoom.value;
      const sw = cw / scale / digital;
      const sh = ch / scale / digital;
      const sx = (vw - sw) / 2;
      const sy = (vh - sh) / 2;

      const out = longSide ? Math.min(1, longSide / Math.max(sw, sh)) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw * out);
      canvas.height = Math.round(sh * out);
      const ctx = canvas.getContext("2d")!;
      // Front camera: we send/save the true (un-mirrored) image; the overlay flips coordinates instead.
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return { canvas, dataUrl: canvas.toDataURL("image/jpeg", quality) };
    },
    [zoom]
  );

  // ---------- coach ----------
  const onCoach = async () => {
    if (loading || phase !== "live") return;
    const frame = grabFrame(COACH_LONG_SIDE, 0.82);
    if (!frame) return;
    setLoading(true);
    setShowDetails(false);

    const previous = coaching && Date.now() - lastCoachAt.current < PREVIOUS_TTL_MS ? coaching : null;
    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: frame.dataUrl.split(",")[1],
          orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
          zoom: Math.round(zoom.value * 10) / 10,
          camera: facing === "user" ? "front" : "back",
          previous,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Coaching failed");
      const c = data as Coaching;
      setCoaching(c);
      lastCoachAt.current = Date.now();
      speak(c.headline);

      if (Math.abs(c.zoom_factor - 1) >= 0.1) {
        const before = zoom.value;
        const after = await applyZoom(before * c.zoom_factor);
        if (Math.abs(after - before) >= 0.05) showToast(`Zoomed to ${after.toFixed(1)}×`);
        else if (c.zoom_factor < 1) showToast("Already at widest. Step back instead");
      }
    } catch (e) {
      showToast((e as Error).message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const onNewShot = () => {
    setCoaching(null);
    lastCoachAt.current = 0;
    window.speechSynthesis?.cancel();
  };

  // ---------- capture photo ----------
  const onCapture = async () => {
    const frame = grabFrame(null, 0.95);
    if (!frame) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    const blob: Blob | null = await new Promise((r) => frame.canvas.toBlob(r, "image/jpeg", 0.95));
    if (!blob) return;
    const file = new File([blob], `frame-coach-${Date.now()}.jpg`, { type: "image/jpeg" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] });
        return;
      } catch {
        /* user cancelled share → fall back to download */
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // ---------- render ----------
  const mirror = facing === "user";
  const fx = (x: number) => (mirror ? 1 - x : x) * 100; // capture is un-mirrored, preview is mirrored → flip x
  const level = tilt != null && Math.abs(tilt) < 1.5;
  const digitalScale = zoom.hardware ? 1 : zoom.value;
  const videoTransform = `${mirror ? "scaleX(-1) " : ""}scale(${digitalScale})`;
  const showArrow =
    coaching?.subject && coaching?.target && Math.hypot(coaching.subject.x - coaching.target.x, coaching.subject.y - coaching.target.y) > 0.06;

  return (
    <main className="app">
      <video ref={videoRef} className="video" playsInline muted autoPlay style={{ transform: videoTransform }} />

      {phase === "live" && (
        <>
          {/* Rule-of-thirds grid + coaching overlay */}
          <svg className="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <g className="grid">
              <line x1="33.33" y1="0" x2="33.33" y2="100" />
              <line x1="66.66" y1="0" x2="66.66" y2="100" />
              <line x1="0" y1="33.33" x2="100" y2="33.33" />
              <line x1="0" y1="66.66" x2="100" y2="66.66" />
            </g>
            {coaching?.target && (
              <g className="target">
                <ellipse cx={fx(coaching.target.x)} cy={coaching.target.y * 100} rx="4" ry="2.4" />
              </g>
            )}
            {showArrow && (
              <line
                className="arrow"
                x1={fx(coaching!.subject!.x)}
                y1={coaching!.subject!.y * 100}
                x2={fx(coaching!.target!.x)}
                y2={coaching!.target!.y * 100}
              />
            )}
            {coaching?.subject && (
              <ellipse className="subject" cx={fx(coaching.subject.x)} cy={coaching.subject.y * 100} rx="2.2" ry="1.3" />
            )}
          </svg>

          {tilt != null && (
            <div className={`level ${level ? "ok" : ""}`} aria-label={`Tilt ${tilt} degrees`}>
              <span className="tick left" />
              <span className="bar" style={{ transform: `rotate(${tilt}deg)` }} />
              <span className="tick right" />
            </div>
          )}

          <header className="topbar">
            <div className="brand">
              Frame<span>Coach</span>
            </div>
            <div className="top-actions">
              <button className="icon-btn zoom" onClick={cycleZoom} aria-label="Change zoom">
                {zoom.value.toFixed(1)}×
              </button>
              <button className="icon-btn" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute voice" : "Mute voice"}>
                {muted ? "🔇" : "🔊"}
              </button>
              <button className="icon-btn" onClick={flipCamera} aria-label="Flip camera">
                🔄
              </button>
            </div>
          </header>

          <section className="bottom">
            {coaching && (
              <div className={`card ${coaching.verdict === "take_it" ? "great" : ""}`} onClick={() => setShowDetails((s) => !s)}>
                <div className="card-head">
                  <div className="score" style={{ ["--p" as string]: coaching.score * 10 }}>
                    <span>{coaching.score}</span>
                  </div>
                  <div className="card-text">
                    <div className="meta">
                      {coaching.progress !== "first" && <span className={`badge ${coaching.progress}`}>{coaching.progress}</span>}
                      <span className="scene">{coaching.scene}</span>
                    </div>
                    <p className="headline">{coaching.headline}</p>
                  </div>
                </div>
                {coaching.moves.length > 0 && (
                  <div className="moves">
                    {coaching.moves.map((m) => (
                      <span key={m} className="move">
                        <b>{MOVE_LABELS[m].icon}</b> {MOVE_LABELS[m].label}
                      </span>
                    ))}
                  </div>
                )}
                {showDetails && coaching.issues.length > 0 && (
                  <ul className="issues">
                    {coaching.issues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
                {!showDetails && coaching.issues.length > 0 && <div className="more">Tap for details</div>}
              </div>
            )}

            <div className="controls">
              <button className="side-btn" onClick={onNewShot} disabled={!coaching} aria-label="Start a new shot">
                <span>↺</span>
                <small>New</small>
              </button>

              <button className={`coach-btn ${loading ? "busy" : ""}`} onClick={onCoach} disabled={loading}>
                {loading ? <span className="spinner" /> : coaching ? "Check again" : "Coach me"}
              </button>

              <button className="side-btn" onClick={onCapture} aria-label="Take photo">
                <span className="shutter" />
                <small>Shoot</small>
              </button>
            </div>

          </section>
        </>
      )}

      {flash && <div className="flash" />}
      {toast && <div className="toast">{toast}</div>}

      {phase !== "live" && (
        <div className="intro">
          <div className="intro-inner">
            <div className="logo">
              <span />
            </div>
            <h1>
              Frame<span>Coach</span>
            </h1>
            <p>Frame your shot, tap <b>Coach me</b>, and Claude tells you where to move, how to angle and how much to zoom.</p>
            {phase === "error" && <p className="err">{error}</p>}
            <button className="start-btn" onClick={onStart} disabled={phase === "starting"}>
              {phase === "starting" ? "Opening camera…" : phase === "error" ? "Try again" : "Start camera"}
            </button>
            <small>Frames are sent to Claude only when you tap Coach me.</small>
          </div>
        </div>
      )}
    </main>
  );
}
