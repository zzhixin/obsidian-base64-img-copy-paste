import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} from "obsidian";
import {
  Annotation,
  ChangeSet,
  EditorState,
  StateEffect,
  Transaction,
  TransactionSpec
} from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { exportMarkdownAsBase64 } from "./base64-export";

interface Base64ImageCopyPasteSettings {
  imageFolder: string;
  defaultImageCaption: string;
}

const DEFAULT_SETTINGS: Base64ImageCopyPasteSettings = {
  imageFolder: "base64-images",
  defaultImageCaption: "image"
};

interface ImageMatch {
  source: string;
  mimeType: string;
  base64: string;
  from: number;
  to: number;
}

const IMAGE_DATA_URL_PATTERN =
  /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]*[A-Za-z0-9+/=])/g;
// Match the surrounding image syntax as well, including escaped clipboard text.
const IMAGE_WRAPPER_PREFIX_PATTERN = /\\?!\\?\[(?:\\.|[^\]\\\r\n])*\\?\]\\?\([ \t]*(<?)\\?$/;
const IMAGE_WRAPPER_SUFFIX_PATTERN = /^[ \t]*(?:"(?:\\.|[^"\\])*"[ \t]*|'(?:\\.|[^'\\])*'[ \t]*)?\\?\)/;
const QUOTE_CITATION_PREFIX_PATTERN = /^>\s?\[@/;
const deferredPasteEffect = StateEffect.define<{ placeholders: string[]; text: string }>();
const internalPasteAnnotation = Annotation.define<boolean>();

export default class Base64ImageCopyPastePlugin extends Plugin {
  settings: Base64ImageCopyPasteSettings;

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension([
      EditorState.transactionFilter.of((tr) => this.filterInputTransaction(tr)),
      ViewPlugin.fromClass(
        class {
          plugin: Base64ImageCopyPastePlugin;
          view: EditorView;

          constructor(view: EditorView) {
            this.view = view;
            this.plugin = Base64ImageCopyPastePlugin.instance;
          }

          update(update: ViewUpdate) {
            for (const transaction of update.transactions) {
              for (const effect of transaction.effects) {
                if (effect.is(deferredPasteEffect)) {
                  void this.plugin.resolveDeferredPaste(update.view, effect.value);
                }
              }
            }
          }
        }
      )
    ]);

    this.registerDomEvent(
      document,
      "paste",
      (event: ClipboardEvent) => {
        void this.handlePaste(event);
      },
      { capture: true }
    );

    this.addSettingTab(new Base64ImageCopyPasteSettingTab(this.app, this));
    this.registerBase64Export();
  }

  private registerBase64Export() {
    this.addCommand({
      id: "copy-as-base64-format",
      name: "Export markdown",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("请先打开需要导出的 Markdown 笔记，再执行 Export markdown");
          return;
        }
        await this.copyAsBase64(file);
      }
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((item) => item
        .setTitle("Export markdown")
        .setIcon("clipboard-copy")
        .onClick(() => this.copyAsBase64(file)));
    }));
  }

  private async copyAsBase64(file: TFile): Promise<void> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const content = view?.file?.path === file.path
        ? view.editor.getValue()
        : await this.app.vault.cachedRead(file);
      const result = await exportMarkdownAsBase64(this.app, content, file.path);
      await navigator.clipboard.writeText(result.content);
      const failures = result.failedPaths.length;
      new Notice(failures
        ? `已复制，转换 ${result.convertedCount} 张图片；${failures} 张本地图片读取失败，已保留原链接`
        : `已复制为 Base64 Markdown，转换 ${result.convertedCount} 张图片`);
    } catch (error) {
      console.error("Export markdown failed", error);
      new Notice("复制为 Base64 Markdown 失败，请检查文件和剪贴板权限");
    }
  }

  static instance: Base64ImageCopyPastePlugin;

  async loadSettings() {
    Base64ImageCopyPastePlugin.instance = this;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async handlePaste(event: ClipboardEvent) {
    const editor = this.getActiveMarkdownEditor();
    if (!editor) {
      return;
    }

    const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
    if (!clipboardText) {
      return;
    }

    const images = this.findBase64Images(clipboardText);
    const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(clipboardText);
    if (images.length === 0 && !shouldInsertQuoteCallout) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    try {
      const replacement = await this.transformClipboardText(
        clipboardText,
        images,
        shouldInsertQuoteCallout
      );
      editor.replaceSelection(replacement);
      if (images.length > 0) {
        new Notice(`已保存 ${images.length} 张 base64 图片`);
      }
    } catch (error) {
      console.error("Base64 image paste failed", error);
      new Notice("剪切板内容处理失败，未插入原始 base64 内容");
    }
  }

  private filterInputTransaction(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
    if (tr.annotation(internalPasteAnnotation)) {
      return tr;
    }

    // Vim changes use input.type.compose rather than input.paste. Inspect the
    // resulting input transaction instead of taking over the `p` key so Vim
    // can resolve motions, registers, counts, and linewise paste semantics.
    if (!tr.docChanged || !tr.isUserEvent("input")) {
      return tr;
    }

    const insertedChange = this.getSingleInsertedChange(tr);
    if (!insertedChange) {
      return tr;
    }

    const images = this.findBase64Images(insertedChange.text);
    const shouldInsertQuoteCallout = this.shouldInsertQuoteCallout(insertedChange.text);
    if (images.length === 0 && !shouldInsertQuoteCallout) {
      return tr;
    }

    if (images.length === 0) {
      return this.replaceInsertedChange(
        tr,
        insertedChange,
        this.insertQuoteCallout(insertedChange.text)
      );
    }

    const placeholders = images.map(() => this.createDeferredPastePlaceholder());
    let safeText = this.replaceImageMatches(insertedChange.text, images, placeholders);
    if (shouldInsertQuoteCallout) {
      safeText = this.insertQuoteCallout(safeText);
    }

    return this.replaceInsertedChange(
      tr,
      insertedChange,
      safeText,
      deferredPasteEffect.of({
        placeholders,
        text: insertedChange.text
      })
    );
  }

  private replaceInsertedChange(
    tr: Transaction,
    change: { from: number; to: number; text: string },
    insert: string,
    effect?: StateEffect<unknown>
  ): TransactionSpec {
    const safeChanges = ChangeSet.of(
      { from: change.from, to: change.to, insert },
      tr.startState.doc.length
    );
    const mapOriginalResultToSafeResult = ChangeSet.of(
      {
        from: change.from,
        to: change.from + change.text.length,
        insert
      },
      tr.newDoc.length
    );
    const selection = tr.selection?.map(mapOriginalResultToSafeResult);
    const effects = StateEffect.mapEffects(tr.effects, mapOriginalResultToSafeResult);
    const annotations: Annotation<unknown>[] = [internalPasteAnnotation.of(true)];
    const addToHistory = tr.annotation(Transaction.addToHistory);
    const remote = tr.annotation(Transaction.remote);
    if (addToHistory !== undefined) {
      annotations.push(Transaction.addToHistory.of(addToHistory));
    }
    if (remote !== undefined) {
      annotations.push(Transaction.remote.of(remote));
    }

    return {
      changes: safeChanges,
      selection,
      effects: effect ? [...effects, effect] : effects,
      annotations,
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: tr.scrollIntoView
    };
  }

  private getSingleInsertedChange(
    tr: Transaction
  ): { from: number; to: number; text: string } | null {
    let change: { from: number; to: number; text: string } | null = null;
    let hasMultipleChanges = false;

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (change) {
        hasMultipleChanges = true;
        return;
      }

      change = {
        from: fromA,
        to: toA,
        text: inserted.toString()
      };
    });

    if (!change || hasMultipleChanges) {
      return null;
    }

    return change;
  }

  private createDeferredPastePlaceholder(): string {
    return `![processing-image](base64-img-copy-paste-${Date.now()}-${Math.random().toString(36).slice(2)})`;
  }

  private async resolveDeferredPaste(
    view: EditorView,
    payload: { placeholders: string[]; text: string }
  ): Promise<void> {
    const images = this.findBase64Images(payload.text);
    if (images.length === 0) {
      return;
    }

    try {
      const embeds = await this.createImageEmbeds(images);
      const currentText = view.state.doc.toString();
      const changes = payload.placeholders.flatMap((placeholder, index) => {
        const from = currentText.indexOf(placeholder);
        return from === -1
          ? []
          : [{ from, to: from + placeholder.length, insert: embeds[index] }];
      });
      if (changes.length === 0) {
        return;
      }

      view.dispatch({
        changes,
        annotations: internalPasteAnnotation.of(true)
      });

      if (images.length > 0) {
        new Notice(`已保存 ${images.length} 张 base64 图片`);
      }
    } catch (error) {
      console.error("Deferred base64 image paste failed", error);
      new Notice("Vim 粘贴处理失败，已保留占位符避免插入原始 base64 内容");
    }
  }

  private getActiveMarkdownEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor.hasFocus()) {
      return null;
    }

    return view.editor;
  }

  private findBase64Images(text: string): ImageMatch[] {
    const matches: ImageMatch[] = [];
    IMAGE_DATA_URL_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IMAGE_DATA_URL_PATTERN.exec(text)) !== null) {
      let from = match.index;
      let to = from + match[0].length;
      const prefix = IMAGE_WRAPPER_PREFIX_PATTERN.exec(text.slice(0, from));
      if (prefix) {
        const hasAngleBrackets = prefix[1] === "<";
        const suffixStart = to + (hasAngleBrackets ? 1 : 0);
        const suffix = IMAGE_WRAPPER_SUFFIX_PATTERN.exec(text.slice(suffixStart));
        if (suffix && (!hasAngleBrackets || text[to] === ">")) {
          from -= prefix[0].length;
          to = suffixStart + suffix[0].length;
        }
      }
      matches.push({
        source: match[0],
        mimeType: `image/${match[1].toLowerCase()}`,
        base64: match[2].replace(/\s/g, ""),
        from,
        to
      });
    }

    return matches;
  }

  private shouldInsertQuoteCallout(text: string): boolean {
    return QUOTE_CITATION_PREFIX_PATTERN.test(text);
  }

  private async transformClipboardText(
    text: string,
    images: ImageMatch[],
    shouldInsertQuoteCallout: boolean
  ): Promise<string> {
    let transformedText = text;

    if (images.length > 0) {
      transformedText = await this.replaceImagesWithEmbeds(transformedText, images);
    }

    if (shouldInsertQuoteCallout) {
      transformedText = this.insertQuoteCallout(transformedText);
    }

    return transformedText;
  }

  private insertQuoteCallout(text: string): string {
    return text.replace(/^>\s?(\[@)/, "> [!quote] $1");
  }

  private async replaceImagesWithEmbeds(text: string, images: ImageMatch[]): Promise<string> {
    const embeds = await this.createImageEmbeds(images);
    return this.replaceImageMatches(text, images, embeds);
  }

  private replaceImageMatches(text: string, images: ImageMatch[], replacements: string[]): string {
    const parts: string[] = [];
    let offset = 0;
    images.forEach((image, index) => {
      parts.push(text.slice(offset, image.from), replacements[index]);
      offset = image.to;
    });
    parts.push(text.slice(offset));
    return parts.join("");
  }

  private async createImageEmbeds(images: ImageMatch[]): Promise<string[]> {
    const replacements = new Map<string, string>();

    for (const image of images) {
      if (replacements.has(image.source)) {
        continue;
      }

      const pngData = await this.toPngArrayBuffer(image);
      const imagePath = await this.savePngImage(pngData);
      replacements.set(image.source, this.buildImageEmbed(imagePath));
    }

    return images.map((image) => replacements.get(image.source) ?? image.source);
  }

  private buildImageEmbed(imagePath: string): string {
    const caption = this.settings.defaultImageCaption.trim();
    return `![${caption}](${imagePath})`;
  }

  private async savePngImage(data: ArrayBuffer): Promise<string> {
    const folder = normalizePath(this.settings.imageFolder.trim() || DEFAULT_SETTINGS.imageFolder);
    await this.ensureFolder(folder);

    let path = "";
    for (let index = 0; index < 1000; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`;
      path = normalizePath(`${folder}/${this.getTimestamp()}${suffix}.png`);
      if (!(await this.app.vault.adapter.exists(path))) {
        break;
      }
    }

    await this.app.vault.createBinary(path, data);
    return path;
  }

  private async ensureFolder(folder: string) {
    const parts = folder.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) {
        throw new Error(`${current} is a file, not a folder`);
      }
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private getTimestamp(): string {
    const now = new Date();
    const pad = (value: number, length = 2) => value.toString().padStart(length, "0");

    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
      "-",
      pad(now.getMilliseconds(), 3)
    ].join("");
  }

  private async toPngArrayBuffer(image: ImageMatch): Promise<ArrayBuffer> {
    if (image.mimeType === "image/png") {
      return this.base64ToArrayBuffer(image.base64);
    }

    return this.convertImageToPng(image.source);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  private async convertImageToPng(dataUrl: string): Promise<ArrayBuffer> {
    const image = await this.loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create canvas context");
    }

    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("Could not convert image to PNG");
    }

    return blob.arrayBuffer();
  }

  private async loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load base64 image"));
      image.src = dataUrl;
    });
  }

}

class Base64ImageCopyPasteSettingTab extends PluginSettingTab {
  plugin: Base64ImageCopyPastePlugin;

  constructor(app: App, plugin: Base64ImageCopyPastePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("图片存储文件夹名称")
      .setDesc("base64 图片会保存到该 vault 相对路径中。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.imageFolder)
          .setValue(this.plugin.settings.imageFolder)
          .onChange(async (value) => {
            const normalizedValue = normalizePath(value.trim() || DEFAULT_SETTINGS.imageFolder);
            this.plugin.settings.imageFolder = normalizedValue;
            await this.plugin.saveSettings();

            if (/\s/.test(normalizedValue)) {
              new Notice("图片存储路径包含空格，插入的 Markdown 图片路径可能无法按预期工作。");
            }
          })
      );

    new Setting(containerEl)
      .setName("默认插入图片的 caption 名称")
      .setDesc("生成 Markdown 图片引用时使用的默认 caption 文本。留空则插入空 caption。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.defaultImageCaption)
          .setValue(this.plugin.settings.defaultImageCaption)
          .onChange(async (value) => {
            this.plugin.settings.defaultImageCaption = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
