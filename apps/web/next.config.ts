import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@neuro-pay/types", "@neuro-pay/carousel"],
};

export default nextConfig;
