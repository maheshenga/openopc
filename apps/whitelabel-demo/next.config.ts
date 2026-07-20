import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The entire data layer is the @kortix/sdk workspace package (TS source) — transpile it.
  transpilePackages: ['@kortix/intelligence-contracts', '@kortix/sdk'],
  webpack: (webpackConfig) => {
    // Workspace ESM packages keep `.js` specifiers for their published output.
    // Resolve those specifiers back to TypeScript while consuming source locally.
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return webpackConfig;
  },
};

export default config;
