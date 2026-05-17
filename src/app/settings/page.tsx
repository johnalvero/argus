"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMe } from "@/lib/useMe";

/**
 * /settings has no content of its own — every tab is admin-only now
 * (Profile moved to /profile and the user menu in the header). Redirect
 * admins to the first useful tab, non-admins back to the host list.
 */
export default function SettingsIndex() {
  const router = useRouter();
  const { data: me, isLoading } = useMe();

  useEffect(() => {
    if (isLoading || !me) return;
    router.replace(me.isAdmin ? "/settings/branding" : "/");
  }, [isLoading, me, router]);

  return null;
}
