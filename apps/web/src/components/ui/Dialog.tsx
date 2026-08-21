"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./Button";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/**
 * Themed modal. Reuses the paper/ink tokens so the blotter aesthetic
 * carries through focus traps and overlays without a second design system.
 */
export function DialogContent({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className="fixed inset-0 z-40"
        style={{ background: "rgba(20, 18, 15, 0.45)" }}
      />
      <DialogPrimitive.Content
        className="fixed top-1/2 left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 border p-6 shadow-xl focus:outline-none"
        style={{
          borderColor: "var(--line)",
          background: "var(--paper)",
          color: "var(--ink)",
        }}
      >
        <DialogPrimitive.Title
          className="text-sm tracking-[0.2em] uppercase"
          style={{ color: "var(--muted)" }}
        >
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description
            className="mt-2 text-sm"
            style={{ color: "var(--muted)" }}
          >
            {description}
          </DialogPrimitive.Description>
        ) : null}
        <div className="mt-5">{children}</div>
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute top-3 right-3 px-2 py-1 text-sm"
          style={{ color: "var(--muted)" }}
        >
          ×
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * Cancel-style action for inside a dialog. Wires Radix Close semantics
 * to the themed Button so the dialog can dismiss from any nested trigger.
 */
export function DialogCancelButton({ children }: { children: ReactNode }) {
  return (
    <DialogPrimitive.Close asChild>
      <Button tone="neutral">{children}</Button>
    </DialogPrimitive.Close>
  );
}
