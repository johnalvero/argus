"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Three-option theme switcher (light / dark / system).
 *
 * Renders as a Button trigger with a small inline menu. We don't pull in
 * a full DropdownMenu primitive for a single 3-item picker — a
 * click-outside listener and Escape handling cover the affordance.
 *
 * Mounted-state guard avoids a hydration mismatch between the server
 * (which doesn't know the theme) and the client (which does).
 */
const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

type ThemeValue = (typeof OPTIONS)[number]["value"];

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // Click-outside + Escape to close. Cheap; no need for a portal here.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Pre-mount: render an inert placeholder of the correct size to avoid
  // layout shift. Use the Sun icon so SSR output is deterministic.
  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label="Theme"
        className="h-8 w-8 px-0 text-muted-foreground"
        disabled
      >
        <Sun className="h-3.5 w-3.5" />
      </Button>
    );
  }

  const current = (theme as ThemeValue | undefined) ?? "system";
  // Visual icon mirrors what the user actually sees right now, not the
  // selection — so "System" shows the resolved sun/moon, not a monitor.
  const VisualIcon =
    current === "system"
      ? resolvedTheme === "dark"
        ? Moon
        : Sun
      : current === "dark"
      ? Moon
      : Sun;

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Toggle theme"
        title="Toggle theme"
        className="h-8 w-8 px-0 text-muted-foreground hover:text-foreground"
      >
        <VisualIcon className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = current === opt.value;
            return (
              <button
                key={opt.value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setTheme(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent text-accent-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="flex-1 text-left">{opt.label}</span>
                {active && (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-foreground"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
