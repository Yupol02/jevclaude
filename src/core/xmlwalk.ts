import { XMLParser } from "fast-xml-parser";

/** A UI-hierarchy XML node with its tag, attributes and ordered children. */
export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  // Keep values as strings: resource ids like "123" must not become numbers.
  parseAttributeValue: false,
  parseTagValue: false,
});

type Ordered = Record<string, unknown> & { ":@"?: Record<string, string> };

function convert(items: Ordered[]): XNode[] {
  const out: XNode[] = [];
  for (const item of items) {
    const tag = Object.keys(item).find((k) => k !== ":@");
    if (!tag || tag.startsWith("?") || tag === "#text") continue;
    const kids = item[tag];
    out.push({ tag, attrs: item[":@"] ?? {}, children: Array.isArray(kids) ? convert(kids as Ordered[]) : [] });
  }
  return out;
}

/** Parse XML preserving child order across mixed tag names (UiAutomator2 / WDA use class names as tags). */
export function parseXmlTree(xml: string): XNode[] {
  return convert(parser.parse(xml) as Ordered[]);
}
