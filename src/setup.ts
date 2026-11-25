import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILE, DEFAULT_CONFIG_YAML, loadConfig } from "./config.js";
import { Adb } from "./driver/android/adb.js";
import { Uia2Client } from "./driver/android/uia2.js";
import { setupWda } from "./driver/ios/driver.js";
import { bootedSimulators, listSimulators, simctl } from "./driver/ios/simctl.js";
import { WdaClient } from "./driver/ios/wda.js";
import { jevFromEnv } from "./jev/providers.js";

const exec = promisify(execFile);

/** Pinned versions of the open-source device servers jevclaude installs. */
export const UIA2_VERSION = "10.6.6";
export const WDA_VERSION = "16.15.3";

export const HOME = process.env.JEVCLAUDE_HOME ?? join(homedir(), ".jevclaude");

async function download(url: string, dest: string, log: (m: string) => void) {
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Install the Appium UiAutomator2 server on the phone (fast screen reads, Unicode typing). */
export async function setupAndroid(serial: string | undefined, log: (m: string) => void) {
  const dir = join(HOME, "uia2", UIA2_VERSION);
  await mkdir(dir, { recursive: true });
  const rel = `https://github.com/appium/appium-uiautomator2-server/releases/download/v${UIA2_VERSION}`;
  const files = [`appium-uiautomator2-server-v${UIA2_VERSION}.apk`, "appium-uiautomator2-server-debug-androidTest.apk"];
  for (const f of files) {
    if (!existsSync(join(dir, f))) await download(`${rel}/${f}`, join(dir, f), log);
  }
  const devices = (await Adb.devices()).filter((d) => d.state === "device" && (!serial || d.serial === serial));
  if (devices.length === 0) throw new Error("no Android device connected (check `adb devices`)");
  for (const d of devices) {
    const adb = new Adb(d.serial);
    for (const f of files) {
      log(`installing ${f} on ${d.serial}`);
      await adb.install(join(dir, f));
    }
    const ok = await Uia2Client.isInstalled(adb);
    log(ok ? `✓ UiAutomator2 server ready on ${d.serial}` : `✗ install did not register on ${d.serial}`);
  }
}

/** Boot a simulator if none is running, then install and start WebDriverAgent on it. */
export async function setupIos(udid: string | undefined, log: (m: string) => void) {
  if (process.platform !== "darwin") throw new Error("iOS setup needs macOS with Xcode");
  let target = udid;
  if (!target) {
    const booted = await bootedSimulators();
    if (booted[0]) target = booted[0].udid;
    else {
      const phone = (await listSimulators()).find((d) => /iPhone/.test(d.name));
      if (!phone) throw new Error("no iPhone simulator available; create one in Xcode");
      log(`booting ${phone.name} (${phone.runtime})`);
      await simctl(["boot", phone.udid], 180_000);
      await exec("open", ["-a", "Simulator"]).catch(() => {});
      target = phone.udid;
    }
  }
  await simctl(["bootstatus", target, "-b"], 300_000);

  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const dir = join(HOME, "wda", WDA_VERSION, arch);
  const app = join(dir, "WebDriverAgentRunner-Runner.app");
  if (!existsSync(app)) {
    await mkdir(dir, { recursive: true });
    const zip = join(dir, "wda.zip");
    await download(
      `https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Build-Sim-${arch}.zip`,
      zip,
      log,
    );
    await exec("ditto", ["-x", "-k", zip, dir]);
  }
  log(`installing WebDriverAgent on ${target}`);
  await setupWda(target, app);
  log("✓ WebDriverAgent is answering on http://127.0.0.1:8100");
}

/** Health check: tools, devices, servers, Jev key, config. */
export async function doctor(): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const check = (pass: boolean, msg: string, hint?: string) => {
    lines.push(`${pass ? "✓" : "✗"} ${msg}${!pass && hint ? `\n    → ${hint}` : ""}`);
    if (!pass) ok = false;
  };
  const info = (msg: string) => lines.push(`· ${msg}`);

  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, `Node ${process.versions.node}`, "Node 20 or newer is required");

  try {
    loadConfig();
    info(existsSync(CONFIG_FILE) ? `${CONFIG_FILE} is valid` : `no ${CONFIG_FILE} (defaults in use; \`jevclaude init\` creates one)`);
  } catch (e) {
    check(false, (e as Error).message);
  }

  const adbDevices = await Adb.devices().catch(() => undefined);
  if (!adbDevices) info("adb not found (Android support off) — install Android platform-tools");
  else {
    const ready = adbDevices.filter((d) => d.state === "device");
    info(`adb: ${ready.length} device(s)${ready.length ? `: ${ready.map((d) => d.model ?? d.serial).join(", ")}` : ""}`);
    for (const d of adbDevices.filter((x) => x.state !== "device"))
      check(false, `${d.serial} is ${d.state}`, "unlock the phone and accept the USB debugging prompt");
    for (const d of ready) {
      const uia2 = await Uia2Client.isInstalled(new Adb(d.serial)).catch(() => false);
      check(
        uia2,
        `UiAutomator2 server on ${d.serial}`,
        "run `jevclaude setup android` for fast reads and Unicode typing (adb fallback still works)",
      );
    }
  }

  if (process.platform === "darwin") {
    const sims = await bootedSimulators();
    info(`iOS simulators booted: ${sims.length ? sims.map((s) => `${s.name} (${s.runtime})`).join(", ") : "none"}`);
    if (sims.length) {
      const st = await new WdaClient(loadConfig().ios?.wda_url).status();
      check(Boolean(st), "WebDriverAgent reachable", "run `jevclaude setup ios`");
    }
  }

  try {
    const jev = jevFromEnv(process.env, loadConfig().jev ?? {});
    const t0 = performance.now();
    const res = await jev.ask({ state: "ping", questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } } });
    const a = res.answers.ok;
    check(a?.type === "noul", `Jev (${jev.name}, ${res.model}) answered in ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    check(false, `Jev: ${(e as Error).message}`, "set TYPESAFE_API_KEY (or Cloudflare keys) in .env");
  }
  return { ok, lines };
}

const EXAMPLE_FLOW = `# Example flow — change \`app\` to your package (Android) or bundle id (iOS).
name: smoke
app: com.example.app
fresh_start: true
permissions: stop        # allow | deny | stop when a system permission dialog shows up
steps:
  - launch
  - expect: "The app's first screen is shown without errors"
`;

export async function init(log: (m: string) => void) {
  if (!existsSync(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, DEFAULT_CONFIG_YAML);
    log(`created ${CONFIG_FILE}`);
  }
  await mkdir("flows", { recursive: true });
  if (!existsSync("flows/smoke.yaml")) {
    await writeFile("flows/smoke.yaml", EXAMPLE_FLOW);
    log("created flows/smoke.yaml");
  }
  if (!existsSync(".env")) {
    await writeFile(".env", "# Jev provider key (never commit this file)\nTYPESAFE_API_KEY=\n");
    log("created .env (add your TYPESAFE_API_KEY)");
  }
  log("\nConnect Claude Code:\n  claude mcp add jevclaude -- npx -y jevclaude mcp");
}
