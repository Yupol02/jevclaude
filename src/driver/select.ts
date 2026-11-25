import { Adb } from "./android/adb.js";
import { type AndroidBackend, AndroidDriver } from "./android/driver.js";
import { IosDriver } from "./ios/driver.js";
import { bootedSimulators } from "./ios/simctl.js";
import type { Driver, Platform } from "./types.js";

export interface DeviceRef {
  platform: Platform;
  id: string;
  label: string;
}

/** All devices we could drive right now: adb devices in `device` state + booted iOS simulators. */
export async function listDevices(): Promise<DeviceRef[]> {
  const [android, ios] = await Promise.all([
    Adb.devices()
      .then((ds) => ds.filter((d) => d.state === "device"))
      .catch(() => []),
    process.platform === "darwin" ? bootedSimulators() : Promise.resolve([]),
  ]);
  return [
    ...android.map((d) => ({ platform: "android" as const, id: d.serial, label: d.model ?? d.serial })),
    ...ios.map((d) => ({ platform: "ios" as const, id: d.udid, label: `${d.name} (${d.runtime})` })),
  ];
}

export interface ConnectOptions {
  platform?: Platform;
  /** adb serial or simulator UDID. */
  device?: string;
  androidBackend?: AndroidBackend;
  wdaUrl?: string;
  log?: (m: string) => void;
}

export async function resolveDevice(opts: ConnectOptions = {}): Promise<DeviceRef> {
  const all = await listDevices();
  let pool = all.filter((d) => (!opts.platform || d.platform === opts.platform) && (!opts.device || d.id === opts.device));
  if (opts.device && pool.length === 0) {
    // Allow explicit ids that list() can't see (e.g. adb over TCP not yet listed).
    return { platform: opts.platform ?? "android", id: opts.device, label: opts.device };
  }
  if (pool.length === 0) {
    throw new Error(
      `No ${opts.platform ?? "Android or iOS"} device found. Android: connect a phone with USB debugging (check \`adb devices\`). iOS: boot a simulator and run \`jevclaude setup ios\`.`,
    );
  }
  if (pool.length > 1) {
    // Prefer a physical/emulated Android device when the platform isn't specified and both exist.
    const byPlatform = new Set(pool.map((d) => d.platform));
    if (byPlatform.size > 1 && !opts.platform) {
      throw new Error(`Both Android and iOS devices are available; set \`platform:\` in the flow or pass --platform.`);
    }
    if (pool.length > 1) throw new Error(`Several devices found (${pool.map((d) => d.id).join(", ")}); pass --device.`);
  }
  pool = pool.slice(0, 1);
  return pool[0]!;
}

export async function connectDriver(opts: ConnectOptions = {}): Promise<Driver> {
  const ref = await resolveDevice(opts);
  if (ref.platform === "ios") return IosDriver.connect(ref.id, opts.wdaUrl);
  return AndroidDriver.connect(ref.id, opts.androidBackend ?? "auto", opts.log);
}
