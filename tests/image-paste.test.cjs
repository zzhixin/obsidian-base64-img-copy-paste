const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { buildSync } = require("esbuild");
const { EditorState } = require("@codemirror/state");

// Exercise the actual plugin with only the Obsidian host and image storage stubbed.
const compiled = buildSync({
  entryPoints: [resolve(__dirname, "../main.ts")],
  bundle: true, packages: "external", format: "cjs", write: false
}).outputFiles[0].text;
const pluginModule = { exports: {} };
runInNewContext(compiled, {
  module: pluginModule,
  exports: pluginModule.exports,
  require: (id) => id === "obsidian"
    ? { Plugin: class {}, PluginSettingTab: class {}, Notice: class {} }
    : require(id),
  console
});

const data = "data:image/png;base64,aGVsbG8=";
const embed = "![image](Attachments/test.png)";
function makePlugin() {
  const plugin = new pluginModule.exports.default();
  plugin.settings = { imageFolder: "Attachments", defaultImageCaption: "image" };
  plugin.toPngArrayBuffer = async () => new ArrayBuffer(0);
  plugin.savePngImage = async () => "Attachments/test.png";
  return plugin;
}

const cases = [
  ["bare data URL", data, embed],
  ["Markdown image", `![](${data})`, embed],
  ["existing caption", `![old caption](${data})`, embed],
  ["escaped parentheses", `![]\\(${data}\\)`, embed],
  ["escaped URL prefix", `![]\\(\\${data})`, embed],
  ["fully escaped image", `\\!\\[\\]\\(${data}\\)`, embed],
  ["angle brackets and title", `![old](<${data}> "title")`, embed],
  ["escaped caption bracket", `![old\\] caption](${data})`, embed],
  ["mixed images", `![](${data}) and ${data}`, `${embed} and ${embed}`],
  ["quote and line breaks", `> [@citation]\n> ![](${data})\n`, `> [!quote] [@citation]\n> ${embed}\n`],
  ["outer link", `[![](${data})](https://example.com)`, `[${embed}](https://example.com)`],
  ["ordinary parentheses", `text (${data})`, `text (${embed})`]
];

for (const [name, input, expected] of cases) {
  test(`clipboard: ${name}`, async () => {
    const plugin = makePlugin();
    const actual = await plugin.transformClipboardText(
      input, plugin.findBase64Images(input), plugin.shouldInsertQuoteCallout(input)
    );
    assert.equal(actual, expected);
  });

  test(`Vim transaction: ${name}`, async () => {
    const plugin = makePlugin();
    const view = {
      state: EditorState.create({
        doc: "before\nafter",
        extensions: EditorState.transactionFilter.of(tr => plugin.filterInputTransaction(tr))
      }),
      dispatch(spec) { this.state = this.state.update(spec).state; }
    };
    const transaction = view.state.update({
      changes: { from: 7, insert: input + "\n" },
      userEvent: "input.type.compose"
    });
    view.state = transaction.state;
    assert.equal(view.state.doc.toString().includes("data:image"), false);
    assert.equal(view.state.doc.toString().includes("![]("), false);
    const payload = transaction.effects.find(effect => effect.value?.placeholders)?.value;
    assert.ok(payload);
    await plugin.resolveDeferredPaste(view, payload);
    assert.equal(view.state.doc.toString(), `before\n${expected}\nafter`);
  });
}

test("existing file embeds are unchanged", async () => {
  const plugin = makePlugin();
  const input = "![](Attachments/existing.png) and ![](https://example.com/image.png)";
  assert.equal(await plugin.transformClipboardText(input, plugin.findBase64Images(input), false), input);
});
