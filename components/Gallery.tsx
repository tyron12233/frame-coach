"use client";

import { useEffect, useRef, useState } from "react";

export type Photo = { id: string; url: string; blob: Blob; date: Date };

export default function Gallery({
  photos,
  start,
  onClose,
  onDelete,
  onSave,
}: {
  photos: Photo[];
  start: number;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSave: (p: Photo) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);

  useEffect(() => {
    const el = stripRef.current;
    if (el) el.scrollLeft = start * el.clientWidth;
  }, [start]);

  useEffect(() => {
    if (index >= photos.length) setIndex(Math.max(0, photos.length - 1));
    if (!photos.length) onClose();
  }, [photos.length, index, onClose]);

  const current = photos[Math.min(index, photos.length - 1)];
  if (!current) return null;

  return (
    <div className="gallery">
      <header className="g-top">
        <button onClick={onClose} aria-label="Back">
          ‹
        </button>
        <span>{current.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <div>
          <button onClick={() => onSave(current)} aria-label="Save">
            ⤓
          </button>
          <button onClick={() => onDelete(current.id)} aria-label="Delete">
            🗑
          </button>
        </div>
      </header>
      <div
        className="g-strip"
        ref={stripRef}
        onScroll={(e) => setIndex(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
      >
        {photos.map((p) => (
          <div className="g-slide" key={p.id}>
            <img src={p.url} alt="" />
          </div>
        ))}
      </div>
      <footer className="g-bottom">
        <button className="g-share" onClick={() => onSave(current)}>
          Share
        </button>
      </footer>
    </div>
  );
}
