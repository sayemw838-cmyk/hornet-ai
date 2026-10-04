import { pathToFileURL } from "node:url";

export async function loadSecretResolver(modulePath) {
  if (!modulePath) return { resolve: async () => null };
  const moduleUrl = modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href;
  const module = await import(moduleUrl);
  if (typeof module.createSecretResolver !== "function") throw new Error("Secret resolver module must export createSecretResolver().");
  const resolver = await module.createSecretResolver();
  if (typeof resolver?.resolve !== "function") throw new Error("Secret resolver must implement resolve(secretRef).");
  return { resolve: (secretRef) => resolver.resolve(secretRef) };
}
