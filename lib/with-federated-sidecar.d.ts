import type { ModuleFederationPluginOptions } from "webpack/lib/container/ModuleFederationPlugin";

export type WithFederatedSidecarOptions = {
  removePlugins?: string[];
};

export function withFederatedSidecar(
  federationPluginOptions: ModuleFederationPluginOptions,
  withModuleFederationOptions?: WithFederatedSidecarOptions
): (nextConfig?: any) => any;
