"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ImageIcon,
  Loader2,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/useBranding";
import { LogoCropDialog } from "./LogoCropDialog";

/**
 * Admin → Branding.
 *
 * Two cards: company name + logo. Mirrors the dense, sharp-cornered
 * style of the collector config page. Admin-only — the API enforces
 * this; we also hide the settings sub-tab from non-admins.
 *
 * The logo URL embeds `?v={updatedAt}` so the <img> refetches the
 * moment the row is touched server-side. The route's ETag + 304 dance
 * keeps repeat loads cheap.
 */

const ALLOWED_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// Pre-cropper limits — looser than the server's 500 KB cap because the
// crop will shrink the file anyway. We just need to avoid OOM / jank in
// the canvas pipeline.
const PRE_CROP_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const PRE_CROP_MAX_DIMENSION = 8000; // px on either side

export default function BrandingPage() {
  const { data, mutate, isLoading, error } = useBranding();

  // ─── Company name ────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  useEffect(() => {
    if (data) setName(data.companyName);
  }, [data]);

  const nameError = useMemo<string | null>(() => {
    const trimmed = name.trim();
    if (trimmed.length < 1) return "Company name is required.";
    if (trimmed.length > 80) return "Company name must be 80 characters or fewer.";
    return null;
  }, [name]);

  const nameDirty = useMemo(() => {
    if (!data) return false;
    return name.trim() !== data.companyName;
  }, [data, name]);

  const saveName = async () => {
    if (!data || nameError || !nameDirty) return;
    setSavingName(true);
    try {
      const res = await fetch("/api/admin/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      await mutate();
      toast.success("Company name saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "save failed");
    } finally {
      setSavingName(false);
    }
  };

  // ─── Logo ────────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The file currently sitting in the cropper. `null` keeps the dialog closed.
  const [cropFile, setCropFile] = useState<File | null>(null);

  /**
   * Validates a picked file and, if it passes, opens the crop dialog.
   * Rejects clearly for: bad MIME (incl. GIF), empty, > 8 MB, > 8000px.
   * The server's MIME + 500 KB caps still apply on the cropped upload,
   * but those should be unreachable after cropping to 128×128 PNG.
   */
  const handleFile = async (file: File) => {
    if (file.type === "image/gif") {
      toast.error("Animated GIFs aren't supported — pick a PNG, JPG, or WEBP.");
      return;
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      toast.error(
        "Unsupported image type — only PNG, JPEG, and WEBP are allowed."
      );
      return;
    }
    if (file.size === 0) {
      toast.error("Selected file is empty.");
      return;
    }
    if (file.size > PRE_CROP_MAX_BYTES) {
      toast.error(
        `Source image too large (${(file.size / (1024 * 1024)).toFixed(1)} MB; max 8 MB before cropping).`
      );
      return;
    }

    // Cheap dimension sniff — guards against single-pixel-tall 8000×1
    // monsters that pass the byte check but kill canvas perf.
    const dims = await peekImageDimensions(file).catch(() => null);
    if (dims && (dims.width > PRE_CROP_MAX_DIMENSION || dims.height > PRE_CROP_MAX_DIMENSION)) {
      toast.error(
        `Source image too large (${dims.width}×${dims.height}px; max ${PRE_CROP_MAX_DIMENSION}px on either side).`
      );
      return;
    }

    setCropFile(file);
  };

  /**
   * Runs after the user clicks Apply in the cropper. Same wire format as
   * the old direct-upload path — FormData with field `logo` — so the
   * server route is unchanged.
   */
  const uploadCroppedBlob = async (blob: Blob) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("logo", new File([blob], "logo.png", { type: "image/png" }));
      const res = await fetch("/api/admin/branding/logo", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? `${res.status} ${res.statusText}`);
        throw new Error("upload-failed");
      }
      await mutate();
      toast.success("Logo updated.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const closeCropper = () => {
    setCropFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeLogo = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/admin/branding/logo", {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(err?.error ?? `${res.status} ${res.statusText}`);
        return;
      }
      await mutate();
      toast.success("Logo removed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "remove failed");
    } finally {
      setRemoving(false);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const logoUrl = data?.hasLogo
    ? `/api/branding/logo?v=${encodeURIComponent(data.updatedAt)}`
    : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold tracking-tight">Branding</h3>
        <p className="text-xs text-muted-foreground">
          Company name and logo shown in the sidebar header and elsewhere
          across the admin surface. Changes propagate to every signed-in
          user within a few seconds.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}

      {/* ─── Card 1: company name ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Company name
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading || !data ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label
                  htmlFor="companyName"
                  className="text-xs text-muted-foreground"
                >
                  Display name
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="companyName"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={!!nameError}
                    maxLength={120}
                    className={cn(
                      "h-9 text-sm",
                      nameError &&
                        "border-destructive focus-visible:ring-destructive"
                    )}
                    placeholder="Converge ICT"
                  />
                  <Button
                    type="button"
                    onClick={saveName}
                    disabled={
                      savingName || !!nameError || !nameDirty
                    }
                  >
                    {savingName ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    Save
                  </Button>
                </div>
                {nameError && (
                  <p className="text-[11px] text-destructive">{nameError}</p>
                )}
                {!nameError && (
                  <p className="text-[11px] text-muted-foreground">
                    1–80 characters. Shown under the &quot;Argus&quot; mark
                    in the sidebar.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── Card 2: logo ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            Logo
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading || !data ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : data.hasLogo && logoUrl ? (
            <div className="flex flex-col gap-3">
              <div className="flex h-24 w-24 items-center justify-center rounded-md border bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl}
                  alt="Current logo"
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  Replace logo
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={removeLogo}
                  disabled={removing}
                >
                  {removing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Remove logo
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <DropZone
                dragOver={dragOver}
                uploading={uploading}
                onDragEnter={() => setDragOver(true)}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
              />
              <p className="text-[11px] text-muted-foreground">
                You&apos;ll be able to crop and zoom before uploading.
                Output is a 128×128 PNG. PNG / JPG / WEBP only; source up
                to 8 MB. SVG and animated GIF are not supported.
              </p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </CardContent>
      </Card>

      <LogoCropDialog
        file={cropFile}
        onClose={closeCropper}
        onApply={uploadCroppedBlob}
      />
    </div>
  );
}

/**
 * Reads width/height from an image File without decoding pixels into a
 * canvas. Used to reject pathologically-large dimensions before handing
 * to the cropper.
 */
async function peekImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return dims;
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image dimensions."));
    };
    img.src = url;
  });
}

function DropZone({
  dragOver,
  uploading,
  onDragEnter,
  onDragLeave,
  onDrop,
  onClick,
}: {
  dragOver: boolean;
  uploading: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "flex h-28 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 cursor-pointer",
        dragOver
          ? "border-primary bg-primary/5 text-foreground"
          : "border-input bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
    >
      {uploading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Uploading…</span>
        </>
      ) : (
        <>
          <Upload className="h-4 w-4" />
          <span>Drop a PNG / JPG / WEBP here, or click to choose</span>
        </>
      )}
    </div>
  );
}
