import type { UiElement, UiSnapshot } from "../core/uitree.js";

export type Platform = "android" | "ios";

/** Everything the runner needs from a device. Android (adb / UiAutomator2) and iOS (WebDriverAgent) implement it. */
export interface Driver {
  readonly platform: Platform;
  /** adb serial or simulator UDID. */
  readonly id: string;
  /** Short description for reports, e.g. "android/uia2 R58M123". */
  readonly name: string;

  snapshot(): Promise<UiSnapshot>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  /**
   * Types into the focused field. `target` is the field that was just tapped; drivers that can set a
   * field's text directly (UiAutomator2) use it, because Compose fields don't always report focus.
   * Unicode support depends on the driver (see `unicodeInput`).
   */
  typeText(text: string, target?: UiElement): Promise<void>;
  readonly unicodeInput: boolean;
  /** True when snapshot() is cheap (≈0.2 s), so the runner can afford stability double-checks. */
  readonly fastSnapshot: boolean;
  /** Logical keys: "enter", "back", "home", "tab", "delete", "search", or an Android KEYCODE_* name/number. */
  pressKey(key: string): Promise<void>;
  back(): Promise<void>;
  hideKeyboard(): Promise<void>;
  /** Whether the on-screen keyboard is showing (optional; used to avoid tapping under it). */
  keyboardShown?(): Promise<boolean>;

  launch(app: string): Promise<void>;
  stop(app: string): Promise<void>;
  /** The app currently in the foreground (package / bundle id), if the driver can tell. */
  foregroundApp(): Promise<string | undefined>;

  /** Mark "now" so crashLogs only reports crashes after this point. */
  markLogs(): Promise<void>;
  /** Crash / ANR descriptions for `app` since the last markLogs(). */
  crashLogs(app: string): Promise<string[]>;

  screenshot(): Promise<Buffer>;
  startRecording?(): Promise<void>;
  /** Stops a recording and saves it to `path`; returns the path or undefined if nothing was recorded. */
  stopRecording?(path: string): Promise<string | undefined>;

  close?(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
