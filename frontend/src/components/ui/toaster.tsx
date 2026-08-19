"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { TOAST_DURATION_MS, useToast } from "@/hooks/use-toast";

function subscribe() {
  return () => undefined;
}

export function Toaster() {
  const { toasts, dismiss } = useToast();
  const isClient = useSyncExternalStore(subscribe, () => true, () => false);

  if (!isClient) return null;

  return createPortal(
    <ToastProvider duration={TOAST_DURATION_MS}>
      {toasts.map(function ({
        id,
        title,
        description,
        action,
        href,
        preview,
        tone,
        onNavigate,
        ...props
      }) {
        const body = (
          <>
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            {description ? (
              <ToastDescription className={tone || undefined}>{description}</ToastDescription>
            ) : null}
          </>
        );

        return (
          <Toast key={id} {...props}>
            {preview || !href ? (
              <button type="button" className="gx-toast-body" onClick={() => dismiss(id)}>
                {body}
              </button>
            ) : (
              <Link
                href={href}
                className="gx-toast-body"
                onClick={() => {
                  onNavigate?.();
                  dismiss(id);
                }}
              >
                {body}
              </Link>
            )}
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>,
    document.body,
  );
}
