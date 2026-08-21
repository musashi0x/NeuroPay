"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

/**
 * Themed switch. Not used by the console today; lives here so future
 * toggles (auto-revoke, dark mode, etc.) get accessibility for free.
 */
export const Switch = forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(function Switch(props, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className="relative h-5 w-9 border focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
      style={{ borderColor: "var(--line)", background: "var(--paper)" }}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="block h-4 w-4 translate-x-0.5 transition-transform data-[state=checked]:translate-x-[18px]"
        style={{ background: "var(--ink)" }}
      />
    </SwitchPrimitive.Root>
  );
});
