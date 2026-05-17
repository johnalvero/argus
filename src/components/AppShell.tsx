"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Toaster } from "sonner";
import { useTheme } from "next-themes";
import {
  Gauge,
  LayoutDashboard,
  Package,
  Search,
  Server,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";
import { ArgusWordmark } from "@/components/ArgusWordmark";
import { CveSyncButton } from "@/components/CveSyncButton";
import { NotificationBell } from "@/components/NotificationBell";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/useMe";
import { useBranding } from "@/lib/useBranding";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (p: string) => boolean;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    // Exact-match so /hosts and friends don't light up Dashboard.
    match: (p) => p === "/",
  },
  {
    href: "/hosts",
    label: "Hosts",
    icon: Server,
    // Prefix catches both the list (/hosts) and detail (/hosts/[id]).
    match: (p) => p.startsWith("/hosts"),
  },
  {
    href: "/vulnerabilities",
    label: "Vulnerabilities",
    icon: ShieldAlert,
    match: (p) => p.startsWith("/vulnerabilities"),
  },
  {
    href: "/compliance",
    label: "Compliance",
    icon: Gauge,
    match: (p) => p.startsWith("/compliance"),
  },
  {
    href: "/search",
    label: "Search",
    icon: Search,
    match: (p) => p.startsWith("/search"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: SlidersHorizontal,
    match: (p) => p.startsWith("/settings"),
    adminOnly: true,
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me, isLoading, mutate } = useMe();
  // Branding is cookie-authed; the hook only fires once `me` is loaded
  // and the user is signed in. SWR returns undefined while gated, which
  // the sidebar handles below by falling back to the Package icon +
  // "Converge ICT" defaults.
  const { data: branding } = useBranding();
  // sonner's auto-detect uses prefers-color-scheme only; pipe next-themes
  // through so toasts respect explicit user choice.
  const { resolvedTheme } = useTheme();
  const sonnerTheme =
    resolvedTheme === "dark" ? "dark" : ("light" as "dark" | "light");
  const isLoginRoute = pathname === "/login";
  const isPasswordRoute = pathname === "/password";
  const isChromeless = isLoginRoute || isPasswordRoute;

  // Push to /login when the session disappears under us (cookie expired
  // server-side, logout in another tab, etc.).
  useEffect(() => {
    if (isLoginRoute) return;
    if (!isLoading && me === null) {
      router.replace("/login");
    }
  }, [isLoginRoute, isLoading, me, router]);

  // Mirror middleware: force the password-change page when the gate is set.
  useEffect(() => {
    if (isChromeless) return;
    if (me?.mustChangePassword) {
      router.replace("/password");
    }
  }, [isChromeless, me, router]);

  if (isChromeless) {
    return (
      <>
        {children}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          theme={sonnerTheme}
          toastOptions={{
            style: {
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              borderRadius: "0.375rem",
            },
          }}
        />
      </>
    );
  }

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      mutate(null, { revalidate: false });
      window.location.href = "/login";
    }
  };

  const visibleNav = NAV.filter((item) => {
    if (!item.adminOnly) return true;
    return me?.isAdmin === true;
  });

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex h-24 items-center gap-3 border-b px-3">
          {branding?.hasLogo ? (
            // Cache-buster ?v={updatedAt} forces the browser to refetch
            // the moment an admin uploads or replaces the logo. The
            // /api/branding/logo handler then honors If-None-Match for
            // every load after that.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/branding/logo?v=${encodeURIComponent(branding.updatedAt)}`}
              alt=""
              width={64}
              height={64}
              className="h-16 w-16 rounded-md object-contain"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Package className="h-9 w-9" />
            </div>
          )}
          <div className="flex flex-col gap-1 leading-tight">
            <ArgusWordmark className="h-5 w-auto" />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {branding?.companyName ?? "Converge ICT"}
            </span>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-3 text-[10px] text-muted-foreground">
          <div className="font-mono">v1 · fleet inventory</div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
          <div className="flex items-baseline gap-3">
            <h1 className="text-sm font-semibold tracking-tight">Argus</h1>
            <span className="text-xs text-muted-foreground">
              software inventory across the fleet
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <CveSyncButton isAdmin={me?.isAdmin === true} />
            {me && <NotificationBell />}
            {me && <UserMenu me={me} onSignOut={logout} />}
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
      <Toaster
        position="bottom-right"
        richColors
        closeButton
        theme={sonnerTheme}
        toastOptions={{
          style: {
            fontFamily: "var(--font-inter), system-ui, sans-serif",
            borderRadius: "0.375rem",
          },
        }}
      />
    </div>
  );
}
