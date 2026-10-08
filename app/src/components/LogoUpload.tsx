import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import Fi from './Fi';

/**
 * Square logo uploader with crop. The user picks an image, repositions/zooms it
 * inside a square frame, and confirms — producing a cropped square Blob plus a
 * preview data URL that the parent persists (and later uploads).
 */
export default function LogoUpload({
  previewUrl,
  onCropped,
  onClear,
}: {
  previewUrl: string | null;
  onCropped: (blob: Blob, dataUrl: string) => void;
  onClear: () => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [editingSrc, setEditingSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [areaPixels, setAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const onSelectFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setEditingSrc(reader.result as string);
    reader.readAsDataURL(file);
    // Reset the input so re-selecting the same file fires change again.
    e.target.value = '';
  }, []);

  const onCropComplete = useCallback((_area: Area, pixels: Area) => {
    setAreaPixels(pixels);
  }, []);

  const confirmCrop = useCallback(async () => {
    if (!editingSrc || !areaPixels) return;
    setBusy(true);
    try {
      const blob = await cropToSquareBlob(editingSrc, areaPixels);
      const dataUrl = await blobToDataUrl(blob);
      onCropped(blob, dataUrl);
      setEditingSrc(null);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    } finally {
      setBusy(false);
    }
  }, [editingSrc, areaPixels, onCropped]);

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={onSelectFile}
      />

      {/* Clickable square — the box IS the button */}
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        title={previewUrl ? 'Click to change logo' : 'Click to upload logo'}
        className="relative flex items-center justify-center rounded-xl overflow-hidden border transition-all group"
        style={{
          width: 64,
          height: 64,
          backgroundColor: 'hsl(var(--surface-1))',
          borderColor: 'hsl(var(--border))',
          flexShrink: 0,
          cursor: 'pointer',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'hsl(var(--ring))')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
      >
        {previewUrl ? (
          <>
            <img
              src={previewUrl}
              alt="Logo"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            {/* Hover overlay hint */}
            <div
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
            >
              <Fi icon="pen" style={{ fontSize: 14, color: 'white' }} />
            </div>
          </>
        ) : (
          <Fi icon="image" style={{ fontSize: 20, color: 'hsl(var(--muted-foreground))' }} />
        )}
      </button>

      {/* Crop modal */}
      {editingSrc && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
        >
          <div
            className="rounded-2xl overflow-hidden w-full"
            style={{ maxWidth: 420, backgroundColor: 'hsl(var(--surface-0))', border: '1px solid hsl(var(--border))' }}
          >
            <div className="px-5 py-3 border-b" style={{ borderColor: 'hsl(var(--border))' }}>
              <span className="text-display font-semibold" style={{ fontSize: 14 }}>Crop logo (square)</span>
            </div>
            <div className="relative" style={{ height: 320, backgroundColor: '#000' }}>
              <Cropper
                image={editingSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="rect"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className="px-5 py-4 space-y-4">
              <div className="flex items-center gap-3">
                <Fi icon="magnifying-glass-minus" style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }} />
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="flex-1"
                />
                <Fi icon="magnifying-glass-plus" style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))' }} />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingSrc(null)}
                  className="px-4 py-2 rounded-lg border"
                  style={{ fontSize: 13, borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmCrop}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg font-medium"
                  style={{ fontSize: 13, backgroundColor: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                >
                  {busy ? 'Cropping…' : 'Use image'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ── Canvas crop helpers ─────────────────────────────────────────────────── */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function cropToSquareBlob(src: string, area: Area, size = 512): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, size, size);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Crop failed'))),
      'image/jpeg',
      0.9,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
