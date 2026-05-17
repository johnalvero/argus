"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Download,
  History,
  KeyRound,
  Mail,
  Palette,
  SlidersHorizontal,
  Tag,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMe } from "@/lib/useMe";

/**
 * Settings shell.
 *
 * Admin-only surface — every tab here drives fleet-wide configuration.
 * Personal preferences (Profile, Change password) moved to the user
 * menu in the header. The sidebar's "Settings" entry is also
 * adminOnly: true, so non-admins never reach this layout in practice.
 */

interface SubTab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Exact match for the leaf, prefix match for the section. */
  match: (p: string) => boolean;
  adminOnly?: boolean;
}

const TABS: SubTab[] = [
  {
    href: "/settings/branding",
    label: "Branding",
    icon: Palette,
    match: (p) => p.startsWith("/settings/branding"),
    adminOnly: true,
  },
  {
    href: "/settings/tags",
    label: "Tags",
    icon: Tag,
    match: (p) => p.startsWith("/settings/tags"),
    adminOnly: true,
  },
  {
    href: "/settings/collector",
    label: "Collector config",
    icon: SlidersHorizontal,
    match: (p) => p.startsWith("/settings/collector"),
    adminOnly: true,
  },
  {
    href: "/settings/tokens",
    label: "Ingest tokens",
    icon: KeyRound,
    match: (p) => p.startsWith("/settings/tokens"),
    adminOnly: true,
  },
  {
    href: "/settings/install",
    label: "Install agent",
    icon: Download,
    match: (p) => p.startsWith("/settings/install"),
    adminOnly: true,
  },
  {
    href: "/settings/users",
    label: "Users",
    icon: Users,
    match: (p) => p.startsWith("/settings/users"),
    adminOnly: true,
  },
  {
    href: "/settings/audit",
    label: "Audit log",
    icon: History,
    match: (p) => p.startsWith("/settings/audit"),
    adminOnly: true,
  },
  {
    href: "/settings/watchlists",
    label: "Watchlists",
    icon: Bell,
    match: (p) => p.startsWith("/settings/watchlists"),
    adminOnly: true,
  },
  {
    href: "/settings/ses",
    label: "Email (SES)",
    icon: Mail,
    match: (p) => p.startsWith("/settings/ses"),
    adminOnly: true,
  },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { data: me } = useMe();

  const visible = TABS.filter((t) => !t.adminOnly || me?.isAdmin === true);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Fleet-wide configuration. Personal preferences live in your
          user menu (top right).
        </p>
      </div>

      <nav
        aria-label="Settings sections"
        className="flex flex-wrap items-center gap-1 border-b pb-2"
      >
        {visible.map((tab) => {
          const Icon = tab.icon;
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}
