"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { animateCenterModalIn, animateCenterModalOut } from "@/lib/center-modal-motion";

function resetModalSurface(panel: HTMLElement, backdrop: HTMLElement | null) {
  panel.style.opacity = "";
  panel.style.transform = "";
  panel.style.pointerEvents = "";
  if (backdrop) {
    backdrop.style.opacity = "";
    backdrop.style.pointerEvents = "";
  }
}

export function useCenterModalDialog({
  open,
  onDismiss,
  lockWhile,
  openKey,
}: {
  open: boolean;
  onDismiss: () => void;
  lockWhile?: boolean;
  /** Re-triggers enter animation when dialog content identity changes. */
  openKey?: string;
}) {
  const [present, setPresent] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const exiting = useRef(false);

  useLayoutEffect(() => {
    if (open) {
      exiting.current = false;
      setPresent(true);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!present || exiting.current) return;
    const panel = panelRef.current;
    if (!panel) return;
    resetModalSurface(panel, backdropRef.current);
    void animateCenterModalIn(panel, backdropRef.current);
  }, [present, openKey]);

  const dismissAnimated = useCallback(async () => {
    if (exiting.current || lockWhile) return;
    exiting.current = true;
    const panel = panelRef.current;
    if (panel) {
      await animateCenterModalOut(panel, backdropRef.current);
    }
    setPresent(false);
    onDismiss();
    exiting.current = false;
  }, [lockWhile, onDismiss]);

  useEffect(() => {
    if (!present) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") void dismissAnimated();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [present, dismissAnimated]);

  return { present, backdropRef, panelRef, dismissAnimated };
}
