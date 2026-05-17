"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound, LogOut, UserCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Me } from "@/lib/types";

/**
 * Header user menu — trigger is the user chip (avatar + email + admin
 * badge), opens a dropdown with Profile / Change password / Sign out.
 *
 * Hand-rolled to match the ThemeToggle pattern; we don't introduce
 * @radix-ui/react-dropdown-menu just for two consumers.
 */
export function UserMenu({
  me,
  onSignOut,
}: {
  me: Me;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside + Escape to close.
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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 transition-colors",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        )}
      >
        <div className="flex h-5 w-5 items-center justify-center rounded-sm bg-primary text-[10px] font-bold uppercase text-primary-foreground">
          {me.email.slice(0, 1).toUpperCase()}
        </div>
        <span className="text-xs font-medium">{me.email}</span>
        {me.isAdmin && (
          <span className="rounded-sm border bg-background px-1 py-[1px] font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            admin
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Link
            role="menuitem"
            href="/profile"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <UserCircle2 className="h-3.5 w-3.5" />
            Profile
          </Link>
          <Link
            role="menuitem"
            href="/password"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Change password
          </Link>
          <div className="my-1 h-px bg-border" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
