import { clean, makeSnapshot, type UiElement, type UiSnapshot } from "../../core/uitree.js";
import { parseXmlTree, type XNode } from "../../core/xmlwalk.js";

const CLICKABLE =
  /^(Button|Cell|Link|Switch|Toggle|Tab|MenuItem|SegmentedControl|Stepper|Slider|PickerWheel|Key|Icon|TextField|SecureTextField|SearchField|TextView)$/;
const EDITABLE = /^(TextField|SecureTextField|SearchField|TextView)$/;
const SCROLLABLE = /^(ScrollView|Table|CollectionView|WebView)$/;
const PROGRESS = /^(ActivityIndicator|ProgressIndicator)$/;
/** Containers whose own label just repeats their children. */
const SKIP_LABEL = /^(Application|Window|Other|Group|NavigationBar|TabBar|Toolbar|StatusBar|Keyboard)$/;

/** Parse WebDriverAgent `/source?format=xml` (XCUIElementType… tags) into a snapshot. */
export function parseIosXml(xml: string): UiSnapshot {
  const roots = parseXmlTree(xml);
  const elements: UiElement[] = [];
  const apps = new Set<string>();
  let screen = { width: 0, height: 0 };

  const visit = (n: XNode, lifted: boolean) => {
    const a = n.attrs;
    const type = (a.type ?? n.tag).replace(/^XCUIElementType/, "");
    const x = Number(a.x ?? 0);
    const y = Number(a.y ?? 0);
    const w = Number(a.width ?? 0);
    const h = Number(a.height ?? 0);
    if (type === "Application") {
      if (a.name) apps.add(a.name);
      if (w > 0) screen = { width: w, height: h };
    }
    const label = clean(a.label);
    const value = clean(a.value);
    const name = a.name ?? "";
    const editable = EDITABLE.test(type);
    const el: UiElement = {
      index: -1,
      cls: type,
      // For fields, the label is the field name and value is its content (or placeholder).
      text: editable ? value : label || (type === "StaticText" ? value || name : ""),
      desc: editable ? label || a.placeholderValue || name : label && value && type !== "StaticText" ? value : "",
      resourceId: name && name !== label ? name : "",
      childText: "",
      pkg: "",
      bounds: { left: x, top: y, right: x + w, bottom: y + h },
      clickable: CLICKABLE.test(type),
      editable,
      scrollable: SCROLLABLE.test(type),
      checkable: type === "Switch" || type === "Toggle",
      checked: (type === "Switch" || type === "Toggle") && value === "1",
      enabled: a.enabled !== "false",
      focused: a.focused === "true",
      password: type === "SecureTextField",
      selected: a.selected === "true",
    };
    const visible = a.visible !== "false" && w > 0 && h > 0;
    const skip = SKIP_LABEL.test(type);
    const actionable = el.clickable || el.editable || el.scrollable || PROGRESS.test(type);
    const interesting = !skip && (actionable || (!lifted && (el.text || el.desc)));
    let liftsChildren = lifted;
    if (visible && interesting) {
      if (el.clickable && !el.text && !el.desc) {
        el.childText = collectText(n).slice(0, 4).join(" · ").slice(0, 120);
      }
      // A cell/button already carries its label; don't repeat its static texts.
      if (el.clickable) liftsChildren = true;
      elements.push(el);
    }
    for (const c of n.children) visit(c, liftsChildren);
  };
  for (const r of roots) visit(r, false);
  return makeSnapshot(elements, [...apps], screen);
}

function collectText(n: XNode, depth = 0): string[] {
  if (depth > 6) return [];
  const own = [clean(n.attrs.label), clean(n.attrs.value)].filter(Boolean);
  return [...new Set([...own, ...n.children.flatMap((c) => collectText(c, depth + 1))])];
}
