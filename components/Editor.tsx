"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LookId } from "@/lib/types";
import { LOOKS, ZERO, combine, lookParams, render, type FrameStyle, type Params } from "@/lib/looks";

type Tab = "looks" | "adjust" | "effects" | "frames";
type AdjustKey = "exposure" | "contrast" | "saturation" | "warmth" | "fade";
type EffectKey = "grain" | "vignette";

const ADJUST: { key: AdjustKey; label: string }[] = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
  { key: "warmth", label: "Warmth" },
  { key: "fade", label: "Fade" },
];
const EFFECTS: { key: EffectKey; label: string }[] = [
  { key: "grain", label: "Grain" },
  { key: "vignette", label: "Vignette" },
];
const FRAMES: { id: FrameStyle; label: string }[] = [
  { id: "none", label: "None" },
  { id: "white", label: "White" },
  { id: "polaroid", label: "Instant" },
  { id: "film", label: "Film" },
];

function scaled(src: HTMLCanvasElement, longSide: number) {
  const k = Math.min(1, longSide / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export default function Editor({
  source,
  suggested,
  aiPicked,
  onSave,
  onDelete,
}: {
  source: HTMLCanvasElement;
  suggested: LookId;
  aiPicked: boolean;
  onSave: (blob: Blob) => void;
  onDelete: () => void;
}) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [tab, setTab] = useState<Tab>("looks");
  const [look, setLook] = useState<LookId>(suggested);
  const [adjust, setAdjust] = useState<Params>({ ...ZERO });
  const [adjustKey, setAdjustKey] = useState<AdjustKey>("exposure");
  const [effectKey, setEffectKey] = useState<EffectKey>("grain");
  const [frame, setFrame] = useState<FrameStyle>("none");
  const [saving, setSaving] = useState(false);

  const previewSrc = useMemo(() => scaled(source, 1400), [source]);
  const thumbs = useMemo(() => {
    const tiny = scaled(source, 160);
    return Object.fromEntries(LOOKS.map((l) => [l.id, render(tiny, l.params, "none").toDataURL("image/jpeg", 0.8)]));
  }, [source]);

  const params = combine(lookParams(look), adjust);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const out = render(previewSrc, params, frame);
      const c = previewRef.current;
      if (!c) return;
      c.width = out.width;
      c.height = out.height;
      c.getContext("2d")!.drawImage(out, 0, 0);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSrc, look, adjust, frame]);

  const save = () => {
    setSaving(true);
    setTimeout(() => {
      const out = render(source, params, frame, 4032);
      out.toBlob(
        (b) => {
          setSaving(false);
          if (b) onSave(b);
        },
        "image/jpeg",
        0.92
      );
    }, 30);
  };

  const touched = (keys: (keyof Params)[]) => keys.some((k) => adjust[k] !== 0);

  return (
    <div className="editor">
      <div className="ed-preview">
        <canvas ref={previewRef} />
      </div>

      <div className="ed-tabs">
        {(["looks", "adjust", "effects", "frames"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {((t === "looks" && aiPicked) ||
              (t === "adjust" && touched(["exposure", "contrast", "saturation", "warmth", "fade"])) ||
              (t === "effects" && touched(["grain", "vignette"])) ||
              (t === "frames" && frame !== "none")) && <i className="tab-dot" />}
          </button>
        ))}
      </div>

      <div className="ed-panel">
        {tab === "looks" && (
          <div className="looks">
            {LOOKS.map((l) => (
              <button key={l.id} className={`look ${look === l.id ? "on" : ""}`} onClick={() => setLook(l.id)}>
                <span className="look-img" style={{ backgroundImage: `url(${thumbs[l.id]})` }}>
                  {aiPicked && l.id === suggested && <em>✦</em>}
                </span>
                <small>{l.name}</small>
              </button>
            ))}
          </div>
        )}

        {tab === "adjust" && (
          <SliderPanel
            items={ADJUST}
            active={adjustKey}
            onActive={(k) => setAdjustKey(k as AdjustKey)}
            value={adjust[adjustKey]}
            min={adjustKey === "fade" ? 0 : -1}
            onChange={(v) => setAdjust((a) => ({ ...a, [adjustKey]: v }))}
            changed={(k) => adjust[k as AdjustKey] !== 0}
          />
        )}

        {tab === "effects" && (
          <SliderPanel
            items={EFFECTS}
            active={effectKey}
            onActive={(k) => setEffectKey(k as EffectKey)}
            value={adjust[effectKey]}
            min={0}
            onChange={(v) => setAdjust((a) => ({ ...a, [effectKey]: v }))}
            changed={(k) => adjust[k as EffectKey] !== 0}
          />
        )}

        {tab === "frames" && (
          <div className="frames">
            {FRAMES.map((f) => (
              <button key={f.id} className={`frame-opt ${frame === f.id ? "on" : ""}`} onClick={() => setFrame(f.id)}>
                <span className={`frame-swatch ${f.id}`} />
                <small>{f.label}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ed-actions">
        <button className="ed-delete" onClick={onDelete}>
          Delete
        </button>
        <button className="ed-reset" onClick={() => (setAdjust({ ...ZERO }), setFrame("none"), setLook(suggested))} aria-label="Reset edits">
          ↺
        </button>
        <button className="ed-save" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "✓ Save"}
        </button>
      </div>
    </div>
  );
}

function SliderPanel({
  items,
  active,
  onActive,
  value,
  min,
  onChange,
  changed,
}: {
  items: { key: string; label: string }[];
  active: string;
  onActive: (k: string) => void;
  value: number;
  min: number;
  onChange: (v: number) => void;
  changed: (k: string) => boolean;
}) {
  return (
    <div className="sliders">
      <div className="slider-chips">
        {items.map((i) => (
          <button key={i.key} className={`${active === i.key ? "on" : ""} ${changed(i.key) ? "changed" : ""}`} onClick={() => onActive(i.key)}>
            {i.label}
          </button>
        ))}
      </div>
      <div className="slider-row">
        <input type="range" min={min * 100} max={100} step={1} value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} />
        <span className="slider-val">{Math.round(value * 100)}</span>
      </div>
    </div>
  );
}
