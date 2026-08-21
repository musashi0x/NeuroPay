"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "ok" | "bad" | "warn" | "neutral";

type ToastItem = {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
};

type ToastContextValue = {
  push: (item: Omit<ToastItem, "id">) => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { color: string; background: string }> = {
  ok: { color: "var(--ok)", background: "var(--ok-wash)" },
  bad: { color: "var(--bad)", background: "var(--bad-wash)" },
  warn: { color: "#7a4b00", background: "#f3e6c8" },
  neutral: { color: "var(--ink)", background: "var(--paper)" },
};

/**
 * Pushes ephemeral toasts and exposes a local `muted` preference that
 * gates `push()`. Motion is owned by `.toast-root` keyframes in
 * globals.css; the data-state hook and the prefers-reduced-motion
 * override live in one place there.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [muted, setMuted] = useState(false);

  const push = useCallback(
    (item: Omit<ToastItem, "id">) => {
      if (muted) return;
      setItems((prev) => [
        ...prev,
        { ...item, id: Date.now() + Math.random() },
      ]);
    },
    [muted],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ push, muted, setMuted }),
    [push, muted],
  );

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={6000}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            onOpenChange={(open) => {
              if (!open) {
                setItems((prev) => prev.filter((it) => it.id !== item.id));
              }
            }}
            className="toast-root border p-3 shadow-md"
            style={{
              ...TONE_STYLES[item.tone],
              borderColor: "currentColor",
            }}
          >
            <ToastPrimitive.Title className="text-sm font-semibold">
              {item.title}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description
                className="mt-1 text-xs"
                style={{ color: "var(--muted)" }}
              >
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="absolute top-1.5 right-2 text-sm"
              style={{ color: "currentColor" }}
            >
              ×
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/**
 * Hook for consumers. Throws if used outside the provider — that's a
 * programmer error worth catching loudly rather than swallowing.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
