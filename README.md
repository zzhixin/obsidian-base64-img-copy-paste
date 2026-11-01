# base64-img-copy-paste

Copy Obsidian notes with local images embedded as base64 Markdown, and convert
pasted base64 images back into image files in your vault.

## Export a note

1. Open a Markdown note.
2. Open the command palette and run **base64-img-copy-paste: Export markdown**.
   You can also choose **Export markdown** from the note's file menu (including
   its `…` menu) or the file explorer context menu.
3. Paste the copied Markdown into your destination application.

The command copies the entire note, including the latest editor changes, to the
clipboard. It does not modify the note or create an exported file on disk.

For example:

```markdown
![Diagram](Attachments/diagram.png)
![[photo.jpg]]
```

becomes Markdown with embedded image data:

```markdown
![Diagram](data:image/png;base64,...)
![photo.jpg](data:image/jpeg;base64,...)
```

Inline Markdown images and Obsidian image embeds are supported, including local
relative paths, URL-encoded filenames and angle-bracket paths containing spaces.
Export preserves the original image bytes and MIME type. Supported image file
extensions are PNG, JPG/JPEG, GIF, WebP, SVG, BMP, AVIF and ICO.

Remote images and existing data URLs are left unchanged. Missing or unreadable
local images retain their links and produce a warning. Non-image note/PDF embeds,
HTML images and reference-style Markdown images are not expanded. Data URLs may
not be supported by every destination application.

## Paste base64 images

Paste text containing an image data URL into a Markdown editor. The plugin saves
the image as a timestamped PNG in the configured vault folder and inserts a
Markdown image reference. Both bare data URLs and `![](data:image/...)` wrappers
are handled without creating nested image syntax.

For asynchronous image processing through editor transactions, temporary image
placeholders are used. Non-PNG input is rendered to PNG, which can discard animation
or vector properties. Conversion depends on the image formats supported by the
device's browser engine.

Vim keys are handled by Obsidian's Vim mode: `yy`/`p` retains linewise behavior,
and combinations such as `fp` remain Vim motions. The plugin transforms supported
input transactions rather than taking over the `p` key or changing Vim registers.

When pasted text starts with `> [@` or `>[@`, the plugin also inserts a quote
callout marker:

```markdown
> [!quote] [@citation]
```

## Settings

- **图片存储文件夹名称** (image folder): vault-relative folder for pasted images;
  defaults to `base64-images`. Prefer a path without spaces for generated embeds.
- **默认插入图片的 caption 名称** (image caption): alt text for generated image
  embeds; defaults to `image`. An empty value produces empty alt text.

Settings are stored in `.obsidian/plugins/img-copy-paste/data.json` (or the
corresponding custom Obsidian configuration folder). Keep this personal file when
updating the plugin; it is not part of the release.

## Installation

This plugin is being prepared for the official community directory. Until it is
listed, install it manually:

1. Download `main.js` and `manifest.json` from a
   [GitHub release](https://github.com/zzhixin/obsidian-base64-img-copy-paste/releases).
2. Create `.obsidian/plugins/img-copy-paste/` in your vault and put both
   files there.
3. Reload Obsidian, open **Settings → Community plugins**, and enable
   **base64-img-copy-paste**.

To update, disable the plugin, replace those two release files, then enable it
again. Preserve `data.json`.

Starting with 0.1.2, the plugin ID is `img-copy-paste` to comply with the community
directory's manifest rules. The display name and repository name are unchanged.
If upgrading from either old ID (`base64-img-paste` or `base64-img-copy-paste`),
disable the old plugin, install the new release in `.obsidian/plugins/img-copy-paste/`,
copy the old folder's `data.json` into the new folder, and enable the new plugin.
Avoid enabling both copies at the same time. Reassign any custom command hotkeys
because Obsidian identifies commands by the plugin ID.

The manifest currently declares Obsidian 1.5.0 or later. The plugin does not use
Node.js or Electron at runtime; mobile clipboard behavior and the declared minimum
Obsidian version still need device testing. Automated tests use a simulated
Obsidian host and do not replace in-app verification.

## Privacy and permissions

- Processing is local. No accounts, payments, analytics or telemetry are required.
- Export reads the selected note and its referenced local images, then writes the
  result to the system clipboard when invoked.
- Paste examines pasted text in the focused Markdown editor and writes image
  files into the configured folder inside the vault.
- The plugin does not fetch remote images, contact remote services, or access
  files outside the vault. Unchanged remote image links may still be loaded by
  Obsidian or by the application where the exported Markdown is opened.
- Export does not modify the source note. Paste edits the active note as requested.

## Development

Use Node.js 20 or later and npm:

```sh
npm ci
npm test
npm run build
```

`npm run dev` watches the TypeScript sources. `npm run release:prepare` runs tests,
builds the plugin and validates/stages the release files under
`release/img-copy-paste/`. See [the release checklist](RELEASING.md) for
publishing and official-directory submission.

## Credits and license

The export feature was inspired by **MD Image Embed** by
[mengzhishanghun](https://github.com/mengzhishanghun), whose supplied plugin declares
the MIT license. The export parser and integration in this repository are
implemented here; the reference plugin itself is not bundled or distributed.

This project is licensed under the [MIT License](LICENSE).

Report problems through [GitHub Issues](https://github.com/zzhixin/obsidian-base64-img-copy-paste/issues).
