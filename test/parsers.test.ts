import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  center,
  describeElement,
  exactLabelMatch,
  findBySelector,
  isLoading,
  labelOf,
  screenContains,
  uniqueSelector,
} from "../src/core/uitree.js";
import { findCrashes, parseDevices, parseForegroundPackage } from "../src/driver/android/adb.js";
import { parseAndroidXml, parseBounds } from "../src/driver/android/xml.js";
import { parseIosXml } from "../src/driver/ios/xml.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("Android: uiautomator dump", () => {
  const snap = parseAndroidXml(fixture("login.xml"));

  it("keeps visible, meaningful elements and lifts child text into clickable containers", () => {
    expect(snap.elements.map(labelOf)).toEqual(["Welcome back", "Email", "Password", "Log in", "Forgot password?", "Delete account"]);
    expect(snap.packages).toEqual(["com.example.shop"]);
    expect(snap.screen).toEqual({ width: 1080, height: 2400 });
    const btn = findBySelector(snap, { id: "btn_login" })[0]!;
    expect(describeElement(btn)).toBe('[3] ViewGroup contains="Log in" id=btn_login {clickable}');
  });

  it("flags password fields without leaking values", () => {
    const pw = findBySelector(snap, { id: "password" })[0]!;
    expect(pw.editable && pw.password).toBe(true);
    expect(describeElement(pw)).toContain("password");
  });

  it("hashes content and fingerprints actionable elements", () => {
    expect(parseAndroidXml(fixture("login.xml")).hash).toBe(snap.hash);
    const changedTitle = parseAndroidXml(fixture("login.xml").replace("Welcome back", "Welcome"));
    expect(changedTitle.hash).not.toBe(snap.hash);
    // non-actionable text changes don't change the fingerprint (cache key stays valid)
    expect(changedTitle.fingerprint).toBe(snap.fingerprint);
  });

  it("matches exact labels and builds unique selectors", () => {
    expect(exactLabelMatch(snap, "log in", "tap")?.resourceId).toBe("com.example.shop:id/btn_login");
    expect(exactLabelMatch(snap, "email", "type")?.resourceId).toBe("com.example.shop:id/email");
    expect(exactLabelMatch(snap, "the login button", "tap")).toBeUndefined();
    const del = findBySelector(snap, { text: "Delete account" })[0]!;
    expect(uniqueSelector(snap, del)).toEqual({ id: "delete" });
    expect(screenContains(snap, "forgot PASSWORD")).toBe(true);
  });
});

describe("Android: UiAutomator2 page source", () => {
  const snap = parseAndroidXml(fixture("uia2-login.xml"));

  it("parses class-named tags, Unicode text, and skips hidden nodes", () => {
    expect(snap.elements.map(labelOf)).toEqual(["Hoş geldiniz", "E-posta", "Giriş yap"]);
    expect(snap.elements[2]!.cls).toBe("Button");
    expect(isLoading(snap)).toBe(false); // the ProgressBar is displayed="false"
  });

  it("detects a visible progress indicator", () => {
    expect(isLoading(parseAndroidXml(fixture("uia2-login.xml").replace('displayed="false"', 'displayed="true"')))).toBe(true);
  });
});

describe("iOS: WebDriverAgent source", () => {
  const snap = parseIosXml(fixture("ios-settings.xml"));

  it("maps XCUIElement types to platform-neutral elements", () => {
    expect(snap.packages).toEqual(["Settings"]);
    expect(snap.screen).toEqual({ width: 393, height: 852 });
    expect(snap.elements.map((e) => `${e.cls}:${labelOf(e)}`)).toEqual([
      "StaticText:Settings",
      "Table:",
      "SearchField:Search",
      "Cell:General",
      "Cell:Privacy & Security",
      "Switch:Airplane Mode",
    ]);
  });

  it("uses accessibility identifiers as ids and reads switch state", () => {
    const general = findBySelector(snap, { id: "com.apple.settings.general" })[0]!;
    expect(general.childText).toBe("General");
    expect(exactLabelMatch(snap, "general", "tap")).toBe(general);
    const sw = findBySelector(snap, { desc: "Airplane Mode" }).concat(findBySelector(snap, { text: "Airplane Mode" }))[0]!;
    expect(sw.checkable && sw.checked).toBe(true);
    expect(center(general.bounds)).toEqual({ x: 196.5, y: 322.5 });
  });
});

describe("adb helpers", () => {
  it("parses bounds", () => {
    expect(parseBounds("[80,840][1000,960]")).toEqual({ left: 80, top: 840, right: 1000, bottom: 960 });
  });

  it("parses adb devices -l", () => {
    const out = "List of devices attached\nR58M123 device usb:1-1 product:x model:SM_G991B device:o1s\nemulator-5554 offline\n\n";
    expect(parseDevices(out)).toEqual([
      { serial: "R58M123", state: "device", model: "SM_G991B" },
      { serial: "emulator-5554", state: "offline", model: undefined },
    ]);
  });

  it("finds the foreground package and crashes for a package", () => {
    expect(parseForegroundPackage("  mCurrentFocus=Window{abc u0 com.example.shop/com.example.shop.MainActivity}")).toBe(
      "com.example.shop",
    );
    const log =
      "E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: com.example.shop, PID: 123\nE AndroidRuntime: java.lang.NullPointerException";
    expect(findCrashes(log, "com.example.shop").length).toBeGreaterThan(0);
    expect(findCrashes(log, "com.other")).toHaveLength(0);
  });
});

describe("selectors on title + summary rows", () => {
  const rows = parseAndroidXml(
    `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1080,2400]">` +
      `<node class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,400][1080,560]"><node class="android.widget.TextView" text="Network &amp; internet" package="com.android.settings" bounds="[180,420][900,480]"/><node class="android.widget.TextView" text="Mobile, Wi-Fi, hotspot" package="com.android.settings" bounds="[180,480][900,540]"/></node>` +
      `<node class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,560][1080,720]"><node class="android.widget.TextView" text="Connected devices" package="com.android.settings" bounds="[180,580][900,640]"/><node class="android.widget.TextView" text="Bluetooth, pairing" package="com.android.settings" bounds="[180,640][900,700]"/></node>` +
      `<node class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,720][1080,880]"><node class="android.widget.TextView" text="Wi-Fi" package="com.android.settings" bounds="[180,740][900,800]"/><node class="android.widget.TextView" text="Bluetooth, pairing" package="com.android.settings" bounds="[180,800][900,860]"/></node>` +
      `</node></hierarchy>`,
  );

  it("matches a row by one of its lifted texts", () => {
    const hits = findBySelector(rows, { text: "Network & internet" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.childText).toBe("Network & internet · Mobile, Wi-Fi, hotspot");
    expect(exactLabelMatch(rows, "connected devices", "tap")?.childText).toMatch(/^Connected devices/);
  });

  it("stays ambiguous when two rows share the text", () => {
    expect(findBySelector(rows, { text: "Bluetooth, pairing" })).toHaveLength(2);
    expect(exactLabelMatch(rows, "Bluetooth, pairing", "tap")).toBeUndefined();
  });
});
