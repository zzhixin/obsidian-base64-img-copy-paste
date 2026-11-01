import { App, TFile, arrayBufferToBase64 } from "obsidian";

/*! Local-image export is inspired by MD Image Embed (mengzhishanghun, MIT),
 * supplied in ref/md-image-embed. Parsing and integration are implemented here. */
const MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon"
};

interface ImageReference {
  from: number;
  to: number;
  path: string;
  // Markdown images replace only the destination; wiki embeds replace the whole token.
  wikiAlt?: string;
}

export interface Base64ExportResult {
  content: string;
  convertedCount: number;
  failedPaths: string[];
}

function closingBracket(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === "[") depth++;
    if (text[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function markdownImage(text: string, start: number): ImageReference | null {
  const altEnd = closingBracket(text, start + 2);
  if (altEnd < 0 || text[altEnd + 1] !== "(") return null;
  let from = altEnd + 2;
  while (/[ \t]/.test(text[from] ?? "")) from++;
  let to = from;
  if (text[from] === "<") {
    to = text.indexOf(">", from + 1);
    if (to < 0) return null;
    to++;
  } else {
    let depth = 0;
    while (to < text.length) {
      const char = text[to];
      if (char === "\\") { to += 2; continue; }
      if (char === "(") depth++;
      if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (/\s/.test(char) && depth === 0) break;
      to++;
    }
  }
  if (to <= from) return null;
  // Validate the closing syntax and optional title without changing either.
  if (!/^(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\)))?[ \t]*\)/.test(text.slice(to))) {
    return null;
  }
  const rawPath = text.slice(from, to);
  return {
    from, to,
    path: (rawPath.startsWith("<") ? rawPath.slice(1, -1) : rawPath)
      .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1")
  };
}

function imageReferences(text: string): ImageReference[] {
  const images: ImageReference[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < text.length;) {
    if (index === 0 || text[index - 1] === "\n") {
      const end = text.indexOf("\n", index);
      const line = text.slice(index, end < 0 ? text.length : end);
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        index = end < 0 ? text.length : end + 1;
        continue;
      }
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
        index = end < 0 ? text.length : end + 1;
        continue;
      }
    }
    if (text[index] === "\\") { index += 2; continue; }
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text[index] === "`") {
      const ticks = /^`+/.exec(text.slice(index))![0];
      const closing = /`+/g;
      closing.lastIndex = index + ticks.length;
      let end: RegExpExecArray | null;
      do { end = closing.exec(text); } while (end && end[0].length !== ticks.length);
      index = end ? end.index + ticks.length : index + ticks.length;
      continue;
    }
    if (text.startsWith("![[", index)) {
      const wiki = /^!\[\[([^\]\r\n]+)\]\]/.exec(text.slice(index));
      if (wiki) {
        const separator = wiki[1].indexOf("|");
        const path = separator < 0 ? wiki[1] : wiki[1].slice(0, separator);
        const alias = separator < 0 ? "" : wiki[1].slice(separator + 1);
        const name = path.split("/").pop() || "image";
        const wikiAlt = /^\d+(?:x\d+)?$/.test(alias) ? `${name}|${alias}` : alias || name;
        images.push({ from: index, to: index + wiki[0].length, path, wikiAlt });
        index += wiki[0].length;
        continue;
      }
    } else if (text.startsWith("![", index)) {
      const image = markdownImage(text, index);
      if (image) {
        images.push(image);
        index = image.to;
        continue;
      }
    }
    index++;
  }
  return images;
}

export async function exportMarkdownAsBase64(
  app: App, content: string, sourcePath: string
): Promise<Base64ExportResult> {
  const parts: string[] = [];
  const result: Base64ExportResult = { content, convertedCount: 0, failedPaths: [] };
  const encodedFiles = new Map<string, string>();
  let offset = 0;
  for (const image of imageReferences(content)) {
    // Keep remote URLs, existing data URLs, and non-image embeds unchanged.
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(image.path)) continue;
    const rawPath = image.path.split("#")[0];
    let path = rawPath;
    try { path = decodeURIComponent(rawPath); } catch { /* Literal % in filenames. */ }
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (!MIME_TYPES[extension]) continue;
    try {
      const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      if (!(file instanceof TFile)) throw new Error("Image file not found");
      let dataUrl = encodedFiles.get(file.path);
      if (!dataUrl) {
        const mime = MIME_TYPES[file.extension.toLowerCase()];
        if (!mime) continue;
        dataUrl = `data:${mime};base64,${arrayBufferToBase64(await app.vault.readBinary(file))}`;
        encodedFiles.set(file.path, dataUrl);
      }
      const replacement = image.wikiAlt === undefined
        ? dataUrl
        : `![${image.wikiAlt.replace(/[\\[\]]/g, "\\$&")}](${dataUrl})`;
      parts.push(content.slice(offset, image.from), replacement);
      offset = image.to;
      result.convertedCount++;
    } catch (error) {
      result.failedPaths.push(path);
      console.error("Base64 image export failed", path, error);
    }
  }
  parts.push(content.slice(offset));
  result.content = parts.join("");
  return result;
}
