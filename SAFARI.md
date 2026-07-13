# Safari support

Safari builds run the same extension code as Chrome, wrapped in a macOS app.

**Requirements:** macOS with **Xcode** installed (the Command Line Tools alone are
not enough), Node 20+, and Safari 16.4+.

---

## Quick start

```bash
npm install
./scripts/make-safari-app.sh --install
```

Then do the four GUI steps the script prints (Safari exposes no CLI for them):

1. **Safari > Settings > Advanced** → check *Show features for web developers*
2. **Develop** menu → check *Allow Unsigned Extensions*
3. **Safari > Settings > Extensions** → enable *Hermes Browser Extension*
4. Grant it access to the sites you want it to read

Open the panel with the toolbar button or `Alt+H`.

> **"Allow Unsigned Extensions" resets every time Safari restarts.** That is Safari
> behaviour, not a bug in this build. To make the extension persist, sign the app
> with an Apple Developer ID — see [Persisting the extension](#persisting-the-extension).

---

## What is different on Safari

### Safari has no native sidebar API, so Hermes mounts one in the page.

Safari implements **neither** sidebar API:

| API | Supported by | Safari |
|---|---|---|
| `chrome.sidePanel` | Chromium only | ❌ |
| `sidebar_action` | Firefox only | ❌ |

(Both report `version_added: false` for Safari in
[mdn/browser-compat-data](https://github.com/mdn/browser-compat-data).)

So `scripts/build-safari.mjs` strips both APIs. On normal `http://` and `https://`
pages, the toolbar action asks the manifest content script to create a fixed
Shadow DOM host at the right edge. That host slides on-screen by toggling an open
class and keeps the Hermes extension document mounted off-canvas when closed, so
the current conversation survives close/reopen cycles.

The sidebar overlays the page; it does not resize or rewrite the site's layout.
Safari start pages, PDFs, browser-internal pages, and tabs without the manifest
content script still fall back to a **narrow detached window**
(`windows.create({ type: 'popup' })`). This is deliberately not an action popover:
a popover closes the moment you click the page, which would break the element
picker and read-the-page-while-chatting flows.

After installing a rebuilt extension, reload any web page that was already open
before testing the toolbar button. Safari does not replace a manifest content
script inside an existing document, and Hermes deliberately avoids dynamic
injection because Safari can reload the target page while performing it.

### Voice dictation

Safari has no `audioCapture` permission. It grants the microphone per-origin in
response to `getUserMedia()`, so the Safari build skips the permission request and
lets Safari prompt natively. Dictation works; the **Open microphone settings**
button does not (it deep-links to a `chrome://settings` URL that has no Safari
equivalent). Grant the mic via Safari's own prompt instead.

---

## Connecting to a remote Hermes (e.g. a Mac mini)

### The CORS gotcha — read this first

Safari serves each extension install from a **randomly generated per-install origin**:

```
safari-web-extension://<UUID>
```

That UUID is **different on every machine and every reinstall**. It is *not* the
`chrome-extension://<id>` value from the Chrome docs, and you cannot know it ahead
of time. If Hermes' `API_SERVER_CORS_ORIGINS` does not contain your exact origin,
every request fails CORS and the panel appears to hang or report a connection error.

**Find your origin:** open the Hermes panel → **Settings → Support diagnostics**.
The `Extension origin` line is the value you need.

### Then, on the Hermes machine

```bash
API_SERVER_ENABLED=true
API_SERVER_PORT=8642
API_SERVER_KEY=<a strong random key>
API_SERVER_CORS_ORIGINS=safari-web-extension://<the UUID from diagnostics>
```

Restart Hermes after changing this.

If several people use the extension against the same Hermes instance, each of them
has a different UUID — every one must be allowlisted.

### Networking

Do **not** expose port 8642 to the public internet. Either:

- put both machines on a private network (**Tailscale** is the least painful) and
  point the extension at `http://<tailscale-name>:8642`, or
- put Hermes behind a trusted HTTPS reverse proxy and use `https://…`.

Then in the extension: **Settings → Remote Gateway** → enter the URL and the API key.

> **macOS local-network prompt:** on macOS 15+, connecting to a plain LAN address
> (`192.168.x.x`) can trigger the system Local Network permission prompt. Allow it
> for Safari. Tailscale addresses (`100.x.x.x`) generally do not trigger this.

---

## Persisting the extension

The quick-start build is **ad-hoc signed**, so Safari treats it as unsigned and drops
it on restart. To make it stick you need an Apple Developer Program membership
($99/yr) and a Developer ID certificate:

1. Open `build/safari/Hermes Browser/Hermes Browser.xcodeproj` in Xcode.
2. Select both targets → **Signing & Capabilities** → set your **Team**, enable
   *Automatically manage signing*.
3. Product → Archive → Distribute App → **Developer ID** → notarize.

The notarized app can be shipped as a DMG on GitHub Releases; users drag it to
`/Applications` and enable it in Safari, with no *Allow Unsigned Extensions* toggle
and no reset on restart.

Mac App Store distribution works too, and additionally goes through App Review.

---

## Troubleshooting

**`error: Embedded binary's bundle identifier is not prefixed with the parent app's
bundle identifier.`**
The converter derives the *app* bundle ID from the app **name** but the *extension*
bundle ID from `--bundle-identifier`. If those disagree — including by case — the
build fails. `scripts/make-safari-app.sh` keeps them in sync; if you change
`APP_NAME`, change `BUNDLE_PREFIX`/`BUNDLE_ID` to match.

**Converter warns that manifest key `type` is unsupported.**
Stale warning. Safari 16.4+ supports ES-module service workers (`"type": "module"`);
[WebKit implemented it](https://github.com/WebKit/WebKit/pull/6010) and Apple's own
docs confirm the old workarounds are no longer needed. Our floor is 16.4. Ignore it.

**The extension does not appear in Safari > Settings > Extensions.**
The app must be *launched* at least once to register its extension with Safari.
Confirm macOS sees it:

```bash
pluginkit -mAv | grep -i hermes
```

**Requests to Hermes fail / the panel hangs.**
Almost always the CORS origin. See [the CORS gotcha](#the-cors-gotcha--read-this-first).
