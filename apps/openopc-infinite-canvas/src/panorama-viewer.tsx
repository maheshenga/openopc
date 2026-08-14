import { RotateCcw } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

export function PanoramaViewer({ src, alt }: { src: string; alt: string }) {
  const [view, setView] = useState({ x: 50, y: 50, zoom: 1 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    viewX: number;
    viewY: number;
  } | null>(null);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewX: view.x,
      viewY: view.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setView((previous) => ({
      ...previous,
      x:
        (((current.viewX - ((event.clientX - current.x) / Math.max(1, rect.width)) * 100) % 100) +
          100) %
        100,
      y: Math.min(
        80,
        Math.max(20, current.viewY - ((event.clientY - current.y) / Math.max(1, rect.height)) * 40),
      ),
    }));
  };

  const stop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const safeUrl = src.replace(/["\\)]/g, (character) => `\\${character}`);

  return (
    <div className="panorama-viewer">
      <div
        className="panorama-stage"
        role="img"
        aria-label={alt}
        style={{
          backgroundImage: `url("${safeUrl}")`,
          backgroundPosition: `${view.x}% ${view.y}%`,
          backgroundSize: `${Math.round(200 * view.zoom)}% ${Math.round(100 * view.zoom)}%`,
        }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        onWheel={(event) => {
          event.stopPropagation();
          setView((previous) => ({
            ...previous,
            zoom: Math.min(2.5, Math.max(1, previous.zoom * Math.exp(event.deltaY * 0.001))),
          }));
        }}
      />
      <span>360°</span>
      <button
        type="button"
        className="panorama-reset"
        title="重置全景视角"
        aria-label="重置全景视角"
        onClick={(event) => {
          event.stopPropagation();
          setView({ x: 50, y: 50, zoom: 1 });
        }}
      >
        <RotateCcw aria-hidden="true" />
      </button>
    </div>
  );
}
