import { useEffect, useState } from "react";

/**
 * Live countdown (in whole seconds) until `expiresAt`. Returns 0 if no
 * expiry was supplied, or once the deadline has passed. Re-renders once
 * per second while the component is mounted.
 */
export function useRemaining(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!expiresAt) return 0;
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
}
