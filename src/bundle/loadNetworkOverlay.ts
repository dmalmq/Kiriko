import { exportNetwork, initKirikoWasm } from "./wasm";
import { parseNetworkOverlay, type ParsedNetwork } from "../map/networkFeatures";

/** Parsed overlay plus the bundle bytes walkable/propose wasm needs. */
export interface LoadedNetworkOverlay {
  network: ParsedNetwork;
  bytes: Uint8Array;
}

/**
 * Fetch a published `.kvb` bundle's bytes and extract its §5 routing network
 * as floor-tagged features for review rendering. Runs the wasm exporter on the
 * main thread on demand (the directions worker only routes; this is only
 * invoked when the user opens the network-review overlay). Throws when the
 * fetch fails or the bundle carries no graph. The bytes stay with the overlay
 * so Connect can call `walkableChord` / `proposeNetworkPaths` without a
 * second fetch.
 */
export async function loadNetworkOverlay(
  bundleUrl: string,
  signal?: AbortSignal,
): Promise<LoadedNetworkOverlay> {
  const response = await fetch(bundleUrl, {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`bundle fetch failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await initKirikoWasm();
  return { network: parseNetworkOverlay(exportNetwork(bytes)), bytes };
}
