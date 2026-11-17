export type SelfContainedResult = { ok: true } | { ok: false; reason: string };

/** Every tag the renderer may emit. Anything else (script, link, a, svg, iframe, base, ...) is refused. */
export const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "header", "footer", "section",
  "div", "span", "p", "b", "strong", "i", "em", "small", "sub", "sup", "br", "hr",
  "table", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td", "ol", "ul", "li", "img",
]);

/** Longest document (in characters) that is scanned; a prescription is far smaller. Bounds the scan time. */
export const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;

// For Task 4: this check cannot see CSS semantics. Document CSS must give user text spans
// (`.v`) `unicode-bidi: isolate`, so right-to-left text cannot reorder the text around it.

const URL_ATTRIBUTES =new Set([
  "href", "srcset", "poster", "action", "formaction", "data", "xlink:href", "background",
  "ping", "cite", "longdesc", "manifest", "codebase", "lowsrc", "dynsrc",
]);

const DATA_IMAGE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_FONT = /^data:font\/woff2;base64,[A-Za-z0-9+/]+={0,2}$/;

// Tags only: user text is escaped, so a literal "<" never comes from user data.
const TAG_SOURCE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.source;
const TAG = new RegExp(TAG_SOURCE, "g");
const TAG_AT = new RegExp(TAG_SOURCE, "y");
const DOCTYPE = /^<!doctype html>/i;
const ATTRIBUTE = /([^\s=/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

const failure = (reason: string): SelfContainedResult => ({ ok: false, reason });

function unquote(value: string): string {
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") ? value.slice(1, -1) : value;
}

// CSS functions that can fetch or reference a resource other than url(); the renderer uses none
// of them, so they are refused outright instead of having their arguments parsed. image-set()
// accepts a bare string as an image URL. Backslash escapes (\69mage-set) are refused below, so
// no function name can be spelled around this list.
const DENIED_CSS_FUNCTION =
  /(?:^|[^A-Za-z0-9_])(?:-[a-z]+-)?(image-set|src|image|cross-fade|element|paint|attr)\s*\(/i;

function checkCss(source: string): SelfContainedResult {
  // Comments are removed first (an unterminated one to the end), so "image-set /**/ (" and
  // "image/**/-set(" are judged as the function they could become.
  const css = source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  if (/@import/i.test(css)) return failure("CSS @import is not allowed");
  if (css.includes("\\")) return failure("CSS escapes are not allowed");
  const denied = DENIED_CSS_FUNCTION.exec(css);
  if (denied) return failure(`CSS function ${denied[1].toLowerCase()}() is not allowed`);
  if (/expression\s*\(/i.test(css)) return failure("CSS expressions are not allowed");
  if (/\blocal\s*\(/i.test(css)) return failure("local() fonts are not allowed");
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!DATA_FONT.test(match[2]) && !DATA_IMAGE.test(match[2])) {
      return failure("CSS url() must be an embedded WOFF2 font or PNG/JPEG image");
    }
  }
  return { ok: true };
}

/**
 * True when the document can render with no network and no file access: only allowed tags,
 * no event handlers, images and fonts only as data: URIs, no CSS imports. Runs before any
 * document is served to a browser or sent to the PDF service.
 */
export function checkSelfContained(document: string): SelfContainedResult {
  if (document.length > MAX_DOCUMENT_CHARS) return failure("document is too large");
  // Every "<" must start a well-formed tag (or the doctype). User text is escaped, so a stray
  // "<" (comment, unterminated tag, a ">" hidden in a quoted value) means the markup is not ours.
  for (let at = document.indexOf("<"); at !== -1; at = document.indexOf("<", at + 1)) {
    TAG_AT.lastIndex = at;
    if (!TAG_AT.test(document) && !DOCTYPE.test(document.slice(at, at + 16))) return failure("malformed markup");
  }
  for (const tag of document.matchAll(TAG)) {
    const name = tag[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return failure(`tag <${name}> is not allowed`);
    if (tag[1] === "/") continue;
    for (const attribute of tag[3].matchAll(ATTRIBUTE)) {
      const attributeName = attribute[1].toLowerCase();
      const value = unquote(attribute[2] ?? "");
      if (attributeName.startsWith("on")) return failure(`event handler ${attributeName} is not allowed`);
      if (attributeName === "src") {
        if (name !== "img" || !DATA_IMAGE.test(value)) return failure("src must be an embedded PNG or JPEG");
        continue;
      }
      if (URL_ATTRIBUTES.has(attributeName)) return failure(`attribute ${attributeName} is not allowed`);
      if (attributeName === "style") {
        // The renderer escapes "&" in attributes, and a browser would decode entities before parsing the CSS.
        if (value.includes("&")) return failure("style attributes must not contain HTML entities");
        const css = checkCss(value);
        if (!css.ok) return css;
      }
      if (name === "meta" && attributeName === "http-equiv" && value.toLowerCase() !== "content-security-policy") {
        return failure("only a Content-Security-Policy meta tag is allowed");
      }
    }
  }
  for (const block of document.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style\s*>/gi)) {
    const css = checkCss(block[1]);
    if (!css.ok) return css;
  }
  return { ok: true };
}
