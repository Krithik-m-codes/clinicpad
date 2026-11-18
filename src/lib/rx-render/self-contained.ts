export type SelfContainedResult = { ok: true } | { ok: false; reason: string };

/** Every tag the renderer may emit. Anything else (script, link, a, svg, iframe, base, ...) is refused. */
export const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "header", "footer", "section",
  "div", "span", "p", "b", "strong", "i", "em", "small", "sub", "sup", "br", "hr",
  "table", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td", "ol", "ul", "li", "img",
]);

/** Longest document (in characters) that is scanned; a prescription is far smaller. A memory guard: the scan itself is linear. */
export const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;

/** Most "<" characters a document may hold; each one is checked as a tag start. */
export const MAX_TAG_STARTS = 200_000;

// Contract for template authors (Tasks 4 and 8):
// - The renderer emits NO CSS comments. Any "/*" in a style block or style attribute is refused,
//   because a "/*" inside a url token or a string is not a comment to the browser, so comment
//   stripping would let the checker and the browser disagree. The font inliner (Task 8) must
//   strip comments from the font CSS it embeds.
// - The renderer uses no url() other than embedded data: images and WOFF2 fonts, and no fragment
//   references (url(#id)); those are refused too.
// - This check cannot see CSS semantics. Document CSS must give user text spans (`.v`)
//   `unicode-bidi: isolate`, so right-to-left text cannot reorder the text around it.

const URL_ATTRIBUTES = new Set([
  "href", "srcset", "poster", "action", "formaction", "data", "xlink:href", "background",
  "ping", "cite", "longdesc", "manifest", "codebase", "lowsrc", "dynsrc",
]);

const DATA_IMAGE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_FONT = /^data:font\/woff2;base64,[A-Za-z0-9+/]+={0,2}$/;

// A tag as a browser reads it: quoted values may hold ">" and "<", everything else may not hold
// "<" (so one failed start cannot rescan a long stretch). Every "<" in the document must start
// one: user text is escaped, so a literal "<" never comes from user data.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'<])*)>/y;
const DOCTYPE = /^<!doctype html>/i;
// An unquoted value runs to whitespace or ">" (not to "=" or a quote), as in HTML.
const ATTRIBUTE = /([^\s=/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
const STYLE_CLOSE = /<\/style[\s/>]/gi;

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

const URL_START = /url[ \t\n\r\f]*\(/gi;
const CSS_SPACE = " \t\n\r\f";
const URL_REFUSED = "CSS url() must be an embedded WOFF2 font or PNG/JPEG image";

/** Every url( must hold exactly one embedded image or font and be closed; linear in the text. */
function checkUrls(css: string): SelfContainedResult {
  URL_START.lastIndex = 0;
  for (let match = URL_START.exec(css); match; match = URL_START.exec(css)) {
    let i = match.index + match[0].length;
    while (i < css.length && CSS_SPACE.includes(css[i])) i += 1;
    let argument: string;
    let close: number;
    const quote = css[i];
    if (quote === '"' || quote === "'") {
      const end = css.indexOf(quote, i + 1);
      if (end === -1) return failure(URL_REFUSED);
      argument = css.slice(i + 1, end);
      close = end + 1;
      while (close < css.length && CSS_SPACE.includes(css[close])) close += 1;
      if (css[close] !== ")") return failure(URL_REFUSED);
    } else {
      close = css.indexOf(")", i);
      if (close === -1) return failure(URL_REFUSED);
      let end = close;
      while (end > i && CSS_SPACE.includes(css[end - 1])) end -= 1;
      argument = css.slice(i, end);
    }
    if (!DATA_FONT.test(argument) && !DATA_IMAGE.test(argument)) return failure(URL_REFUSED);
    URL_START.lastIndex = close + 1;
  }
  return { ok: true };
}

function checkCss(css: string): SelfContainedResult {
  if (css.includes("/*")) return failure("CSS comments are not allowed");
  if (/@import/i.test(css)) return failure("CSS @import is not allowed");
  if (css.includes("\\")) return failure("CSS escapes are not allowed");
  const denied = DENIED_CSS_FUNCTION.exec(css);
  if (denied) return failure(`CSS function ${denied[1].toLowerCase()}() is not allowed`);
  if (/expression\s*\(/i.test(css)) return failure("CSS expressions are not allowed");
  if (/\blocal\s*\(/i.test(css)) return failure("local() fonts are not allowed");
  return checkUrls(css);
}

/**
 * True when the document can render with no network and no file access: only allowed tags,
 * no event handlers, images and fonts only as data: URIs, no CSS imports. Runs before any
 * document is served to a browser or sent to the PDF service.
 */
export function checkSelfContained(document: string): SelfContainedResult {
  if (document.length > MAX_DOCUMENT_CHARS) return failure("document is too large");
  let starts = 0;
  let styleEnd = -1; // CSS up to here was already checked
  // Every "<" is a tag start, including one inside a quoted value (a browser may read it differently).
  for (let at = document.indexOf("<"); at !== -1; at = document.indexOf("<", at + 1)) {
    starts += 1;
    if (starts > MAX_TAG_STARTS) return failure("document has too many tags");
    TAG.lastIndex = at;
    const tag = TAG.exec(document);
    if (!tag) {
      if (DOCTYPE.test(document.slice(at, at + 16))) continue;
      return failure("malformed markup");
    }
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
    if (name === "style" && at >= styleEnd) {
      // A style element runs to its closing tag; without one a browser reads to the end of the document.
      STYLE_CLOSE.lastIndex = at + tag[0].length;
      const close = STYLE_CLOSE.exec(document);
      if (!close) return failure("style element is not closed");
      const css = checkCss(document.slice(at + tag[0].length, close.index));
      if (!css.ok) return css;
      styleEnd = close.index;
    }
  }
  return { ok: true };
}
