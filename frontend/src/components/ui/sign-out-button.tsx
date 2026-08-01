"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiUrl } from "@/lib/api/url";

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);

    try {
      await fetch(apiUrl("/api/auth/logout"), {
        method: "POST",
        credentials: "include",
      });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        className="mobile-icon-btn pressable text-[color:var(--muted-strong)] hover:text-[color:var(--danger)] disabled:opacity-50"
        aria-label="Sign out"
      >
        <LogOut className="size-[18px]" strokeWidth={1.9} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="pressable mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[color:var(--border)] px-3 py-2 text-xs font-semibold text-[color:var(--muted-strong)] transition-colors hover:border-[color:var(--danger)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:cursor-wait disabled:opacity-50"
    >
      <LogOut className="size-3.5" strokeWidth={2} />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
