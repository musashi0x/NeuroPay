import type { ReactNode } from "react";
import { truncated } from "@/components/console/shared";
import { TooltipContent, TooltipRoot, TooltipTrigger } from "@/components/ui";

/**
 * Truncated identifier that opens the matching BscScan page when we know
 * the chain. Unknown chains keep the existing tooltip-only treatment so
 * we never invent a host.
 */
export function ExplorerLink({
  href,
  value,
  children,
}: {
  href: string | null;
  value: string;
  children?: ReactNode;
}) {
  const text = children ?? truncated(value);

  if (href === null) {
    return (
      <TooltipRoot>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="cursor-help font-mono underline decoration-dotted underline-offset-2"
          >
            {text}
          </span>
        </TooltipTrigger>
        <TooltipContent>{value}</TooltipContent>
      </TooltipRoot>
    );
  }

  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono underline underline-offset-2 hover:opacity-80"
        >
          {text}
        </a>
      </TooltipTrigger>
      <TooltipContent>
        {value}
        <span className="mt-1 block text-[var(--muted)]">Open in explorer</span>
      </TooltipContent>
    </TooltipRoot>
  );
}
