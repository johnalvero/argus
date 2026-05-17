"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

/**
 * LogoCropDialog
 *
 * 1:1 cropper for the branding logo. Source file → in-browser pan/zoom →
 * 128×128 PNG → POST to the existing upload endpoint. Aspect is locked
 * because the sidebar slot is square (28×28 @2x).
 *
 * Out of scope for v1: re-cropping a previously-saved logo. The server
 * only stores the cropped 128×128, so the original pixels are gone.
 */

const OUTPUT_SIZE = 128;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.05;

type Props = {
  /** Source file picked by the user. `null` = dialog closed. */
  file: File | null;
  /** Close handler (cancel or after-success). */
  onClose: () => void;
  /** Called with the cropped 128×128 PNG blob. Awaited; should throw on failure. */
  onApply: (blob: Blob) => Promise<void>;
};

export function LogoCropDialog({ file, onClose, onApply }: Props) {
  const open = file !== null;

  // Object URL for the <img> the cropper renders. Revoked on unmount /
  // file swap to avoid leaking blob URLs.
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setImageSrc(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Reset transform state whenever a new file comes in.
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const croppedAreaPxRef = useRef<Area | null>(null);
  useEffect(() => {
    if (file) {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      croppedAreaPxRef.current = null;
    }
  }, [file]);

  const onCropComplete = useCallback((_area: Area, areaPx: Area) => {
    croppedAreaPxRef.current = areaPx;
  }, []);

  const [applying, setApplying] = useState(false);

  const handleApply = async () => {
    if (!file || !imageSrc || !croppedAreaPxRef.current) return;
    setApplying(true);
    try {
      const blob = await cropToPngBlob(imageSrc, croppedAreaPxRef.current);
      if (!blob) {
        toast.error("Could not produce cropped image.");
        return;
      }
      await onApply(blob);
      onClose();
    } catch (e) {
      // onApply already toasts on its own failure; only surface unexpected errors.
      if (e instanceof Error && e.message !== "upload-failed") {
        toast.error(e.message);
      }
    } finally {
      setApplying(false);
    }
  };

  const dialogTitle = useMemo(() => "Crop logo", []);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !applying) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Drag to pan, slide to zoom. Output is a 128×128 PNG.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div
            className="relative mx-auto aspect-square w-full max-w-[320px] overflow-hidden rounded-md border bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
          >
            {imageSrc && (
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                minZoom={ZOOM_MIN}
                maxZoom={ZOOM_MAX}
                zoomSpeed={0.5}
                restrictPosition
                showGrid
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor="logo-zoom"
              className="flex items-center justify-between text-xs text-muted-foreground"
            >
              <span>Zoom</span>
              <span className="font-mono">{zoom.toFixed(2)}×</span>
            </Label>
            <div className="flex items-center gap-2">
              <ZoomOut className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                id="logo-zoom"
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                aria-label="Zoom"
              />
              <ZoomIn className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleApply}
            disabled={applying || !imageSrc}
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── crop math ─────────────────────────────────────────────────────────

/**
 * Loads the source image at `src` and draws the `areaPx` rectangle into
 * a 128×128 canvas, returning a PNG blob. Prefers OffscreenCanvas where
 * available; falls back to a detached <canvas>.
 *
 * Always emits PNG so transparent-background logos survive the round-trip
 * — even if the source was JPEG, since we don't know whether the next
 * logo will need alpha.
 */
async function cropToPngBlob(src: string, areaPx: Area): Promise<Blob | null> {
  const img = await loadImage(src);

  const sx = Math.max(0, Math.round(areaPx.x));
  const sy = Math.max(0, Math.round(areaPx.y));
  const sw = Math.max(1, Math.round(areaPx.width));
  const sh = Math.max(1, Math.round(areaPx.height));

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    return await canvas.convertToBlob({ type: "image/png" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
}

/**
 * Loads an image element from a URL (typically a blob: URL from
 * URL.createObjectURL). We don't use createImageBitmap here because we
 * already have a URL and need to feed drawImage either way; the difference
 * is negligible for one-shot crops.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image for cropping."));
    img.src = src;
  });
}
