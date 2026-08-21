"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Themed tooltip. Used for surfacing full nonce/txhash values that would
 * otherwise wrap or get truncated in the ledger list.
 */
export function TooltipContent({
  children,
  side = "top",
}: {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={6}
        className="z-50 max-w-xs border px-2 py-1 font-mono text-[11px] break-all"
        style={{
          borderColor: "var(--line)",
          background: "var(--paper)",
          color: "var(--ink)",
        }}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
