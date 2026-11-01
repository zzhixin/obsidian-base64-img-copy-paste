# Release and community-directory submission

## Repository details

- Repository: `https://github.com/zzhixin/obsidian-base64-img-copy-paste`
- Default branch: `main`
- Plugin ID and display name: `base64-img-copy-paste`
- Author: `zhixin`
- License: MIT
- Description: `Copies notes with local images as base64 Markdown and converts pasted base64 images into saved PNG embeds.`
- Command: `Export markdown` (also available in the file menu).

## Prepare a version

1. Update `version` in `manifest.json`, `package.json` and the root package entries
   in `package-lock.json`. Add the version and its minimum Obsidian version to
   `versions.json`.
2. Run `npm ci` and `npm run release:prepare`.
3. Review changes and commit the sources, tests, metadata and generated release
   files. Do not add `node_modules/`, `ref/` or personal `data.json` files.
4. Push `main`.
5. Create a GitHub Release targeting that commit, with a tag exactly matching
   `manifest.json` (for example `0.1.1`, without a `v` prefix).
6. Attach `release/base64-img-copy-paste/main.js` and `manifest.json` as individual
   release assets. The source archive and a committed `release/` folder are not
   substitutes for these attachments. This plugin has no `styles.css`.
7. Verify both uploaded files match the staged files, then publish the release.

`versions.json` is maintained in the repository and staged release directory for
compatibility metadata; it does not replace the release manifest attachment.

## Manual checks before official submission

These are runtime checks, not claims that automated tests have performed them:

- Install the release into a test vault. Confirm that **Export markdown** appears
  in both the command palette and the file menu, including after reloading.
- Export Markdown and wiki-link images from an edited note. Confirm that the
  clipboard contains the full latest note and that the source note stays unchanged.
- Paste bare and Markdown-wrapped base64 PNG/JPEG images. Verify image files,
  single-layer embeds, quote callouts, and the image folder/caption settings.
- Exercise Vim `yy`/`p`, `fp`, and visual selection paste.
- Try missing image files and a denied clipboard operation; check the notices.
- Test desktop and mobile if retaining `isDesktopOnly: false`. Verify the declared
  `minAppVersion`, adjusting it to a version actually supported before submission.

## Submit to the official directory

Follow the current [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin).

1. Sign in to [Obsidian Community](https://community.obsidian.md) using the
   maintainer's Obsidian account and connect the GitHub account that owns the repo.
2. Go to **Plugins → New plugin** and enter the repository URL above.
3. Review the [developer policies](https://docs.obsidian.md/community-directory/developer-policies)
   and [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins).
   The maintainer must accept the policies and ongoing support responsibility.
4. Submit and inspect the automated review results. Correct any reported issues
   in a new version and GitHub Release before publishing in the directory.

The directory reads the manifest from the default branch and installs the release
whose tag matches that manifest's version. A published GitHub Release is required;
a draft alone cannot be installed through the directory. GitHub publication does
not itself submit or approve the plugin in the Obsidian directory.

Suggested submission summary:

> Export complete Markdown notes to the clipboard with local images embedded as
> base64, and convert pasted base64 image data back into PNG attachments. Supports
> inline Markdown images and wiki image embeds for export, preserves native Vim
> command handling, and works locally without accounts or network requests.
