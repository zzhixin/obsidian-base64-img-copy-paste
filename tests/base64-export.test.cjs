const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { buildSync } = require("esbuild");

const bundles = new Map();
function loadModule(filename, host, globals = {}) {
  if (!bundles.has(filename)) bundles.set(filename, buildSync({
    entryPoints: [resolve(__dirname, "..", filename)],
    bundle: true, packages: "external", format: "cjs", write: false
  }).outputFiles[0].text);
  const module = { exports: {} };
  runInNewContext(bundles.get(filename), {
    module, exports: module.exports,
    require: id => id === "obsidian" ? host : require(id),
    console: { error() {} }, ...globals
  });
  return module.exports;
}

class TFile {
  constructor(path) { this.path = path; this.extension = path.split(".").pop(); }
}
const host = {
  TFile, MarkdownView: class {}, Plugin: class {}, PluginSettingTab: class {},
  arrayBufferToBase64: bytes => Buffer.from(bytes).toString("base64")
};
const { exportMarkdownAsBase64 } = loadModule("base64-export.ts", host);
const dataUrl = "data:image/png;base64,AAEC/w==";
function vault() {
  const reads = [], resolutions = [];
  const app = {
    metadataCache: {
      getFirstLinkpathDest(path, source) {
        resolutions.push([path, source]);
        if (path === "missing.png") return null;
        return new TFile(path.replace(/^\.\.\//, ""));
      }
    },
    vault: {
      async readBinary(file) {
        reads.push(file.path);
        if (file.path === "broken.png") throw new Error("read failure");
        return Uint8Array.from([0, 1, 2, 255]).buffer;
      }
    }
  };
  return { app, reads, resolutions };
}

test("exports local images, preserves titles, and resolves paths from the source note", async () => {
  const { app, resolutions } = vault();
  const input = '# Note\n![a](../Attachments/a%20b.png "title")\n![b](<Attachments/c d.png>)\n![c](a(b).png)';
  const result = await exportMarkdownAsBase64(app, input, "Notes/test.md");
  assert.equal(result.content, `# Note\n![a](${dataUrl} "title")\n![b](${dataUrl})\n![c](${dataUrl})`);
  assert.deepEqual(resolutions, [
    ["../Attachments/a b.png", "Notes/test.md"], ["Attachments/c d.png", "Notes/test.md"],
    ["a(b).png", "Notes/test.md"]
  ]);
  assert.equal(result.convertedCount, 3);
});

test("exports wiki images, aliases and size suffixes; preserves non-image embeds", async () => {
  const { app } = vault();
  const result = await exportMarkdownAsBase64(app, '![[a.png]] ![[a.png|caption]] ![[a.png|300]] ![[note]] ![[file.pdf]]', 'note.md');
  assert.equal(result.content, `![a.png](${dataUrl}) ![caption](${dataUrl}) ![a.png|300](${dataUrl}) ![[note]] ![[file.pdf]]`);
  assert.equal(result.convertedCount, 3);
});

test("encodes repeated image data only once, without replacing duplicate prose", async () => {
  const { app, reads } = vault();
  const result = await exportMarkdownAsBase64(app, '![](a.png) ![[a.png]] ![](a.png)', 'note.md');
  assert.equal(result.content, `![](${dataUrl}) ![a.png](${dataUrl}) ![](${dataUrl})`);
  assert.deepEqual(reads, ["a.png"]);
});

test("keeps remote images, existing base64, code, escaped syntax and comments unchanged", async () => {
  const { app, reads } = vault();
  const input = `![](https://example.com/a.png) ![](//example.com/a.png) ![](${dataUrl})\n` +
    '`![](a.png)`\n```md\n![](a.png)\n```\n~~~\n![[a.png]]\n~~~\n' +
    '\\![](a.png) <!-- ![](a.png) -->';
  const result = await exportMarkdownAsBase64(app, input, 'note.md');
  assert.equal(result.content, input);
  assert.deepEqual(reads, []);
});

test("keeps missing/unreadable image references and reports failures", async () => {
  const { app } = vault();
  const result = await exportMarkdownAsBase64(app, '![](missing.png) ![](broken.png) ![](good.png)', 'note.md');
  assert.equal(result.content, `![](missing.png) ![](broken.png) ![](${dataUrl})`);
  assert.deepEqual(Array.from(result.failedPaths), ['missing.png', 'broken.png']);
  assert.equal(result.convertedCount, 1);
});

test("uses the original image MIME type", async () => {
  for (const [extension, mime] of [['JPG', 'image/jpeg'], ['svg', 'image/svg+xml'], ['webp', 'image/webp'], ['gif', 'image/gif']]) {
    const { app } = vault();
    const result = await exportMarkdownAsBase64(app, `![](a.${extension})`, 'note.md');
    assert.equal(result.content, `![](data:${mime};base64,AAEC/w==)`);
  }
});

function pluginHarness() {
  const { app } = vault();
  const clipboard = [], notices = [], commands = [];
  const state = { file: new TFile('Notes/live.md'), content: 'latest ![](a.png)', view: null, menu: null };
  const clipboardApi = { async writeText(text) { clipboard.push(text); } };
  const { default: Plugin } = loadModule('main.ts', {
    ...host, Notice: class { constructor(message) { notices.push(message); } }
  }, { navigator: { clipboard: clipboardApi }, document: {} });
  const plugin = new Plugin();
  state.view = { file: state.file, editor: { getValue: () => state.content } };
  app.workspace = {
    getActiveFile: () => state.file,
    getActiveViewOfType: () => state.view,
    on: (event, callback) => { assert.equal(event, 'file-menu'); state.menu = callback; return {}; }
  };
  app.vault.cachedRead = async () => 'disk ![](a.png)';
  plugin.app = app;
  plugin.addCommand = command => commands.push(command);
  plugin.registerEvent = () => {};
  plugin.registerBase64Export();
  return { plugin, state, clipboard, clipboardApi, notices, commands };
}

test("command is always discoverable and exports the latest full editor contents", async () => {
  const { state, clipboard, commands, notices } = pluginHarness();
  assert.equal(commands[0].name, 'Export markdown');
  assert.equal(commands[0].id, 'copy-as-base64-format');
  assert.equal(commands[0].checkCallback, undefined);
  assert.equal(commands[0].editorCheckCallback, undefined);
  assert.equal(typeof commands[0].callback, 'function');
  assert.equal(clipboard.length, 0);
  await commands[0].callback();
  assert.equal(clipboard[0], `latest ![](${dataUrl})`);
  assert.equal(state.content, 'latest ![](a.png)');
  state.file = null;
  await commands[0].callback();
  assert.match(notices.at(-1), /请先打开/);
  state.file = new TFile('image.png');
  await commands[0].callback();
  assert.match(notices.at(-1), /请先打开/);
  assert.equal(clipboard.length, 1);
});

test("plugin startup registers the palette command with no active note", async () => {
  const { plugin, state, commands } = pluginHarness();
  commands.length = 0;
  state.file = null;
  plugin.loadData = async () => ({});
  plugin.registerEditorExtension = () => {};
  plugin.registerDomEvent = () => {};
  plugin.addSettingTab = () => {};
  await plugin.onload();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, 'copy-as-base64-format');
  assert.equal(commands[0].checkCallback, undefined);
  assert.equal(typeof commands[0].callback, 'function');
});

test("reading view without an editor uses the file contents", async () => {
  const { plugin, state, clipboard } = pluginHarness();
  state.view = null;
  await plugin.copyAsBase64(state.file);
  assert.equal(clipboard[0], `disk ![](${dataUrl})`);
});

test("file menu exports the selected file rather than the active editor", async () => {
  const { state, clipboard } = pluginHarness();
  let action;
  state.menu({ addItem(build) {
    const item = { setTitle(title) { assert.equal(title, 'Export markdown'); return item; }, setIcon() { return item; }, onClick(callback) { action = callback; return item; } };
    build(item);
  } }, new TFile('Other.md'));
  await action();
  assert.equal(clipboard[0], `disk ![](${dataUrl})`);
});

test("clipboard failure reports an error without modifying the note", async () => {
  const { plugin, state, clipboardApi, notices } = pluginHarness();
  clipboardApi.writeText = async () => { throw new Error('permission denied'); };
  await plugin.copyAsBase64(state.file);
  assert.match(notices[0], /失败/);
  assert.equal(state.content, 'latest ![](a.png)');
});

test("exported Markdown pastes back as a single image embed", async () => {
  const { plugin, state, clipboard } = pluginHarness();
  state.content = '> [@citation]\n> ![[a.png]]\n';
  await plugin.copyAsBase64(state.file);
  plugin.settings = { imageFolder: 'Attachments', defaultImageCaption: 'image' };
  plugin.toPngArrayBuffer = async image => {
    assert.equal(image.base64, 'AAEC/w==');
    assert.equal(image.mimeType, 'image/png');
    return new ArrayBuffer(0);
  };
  plugin.savePngImage = async () => 'Attachments/roundtrip.png';
  const result = await plugin.transformClipboardText(
    clipboard[0], plugin.findBase64Images(clipboard[0]), plugin.shouldInsertQuoteCallout(clipboard[0])
  );
  assert.equal(result, '> [!quote] [@citation]\n> ![image](Attachments/roundtrip.png)\n');
});
