# Microflow hardware bridge for Penpot

A Penpot plugin that links design tokens to Microflow Studio over MQTT. Studio can read a
token's value and change it, so hardware can drive a design and a design can drive hardware.
The bridge runs while the file is open in the Penpot editor; Penpot does not run plugins in
view mode.

## Tokens

The plugin bridges the tokens in a token set named **MHB**. It creates the set, active, when
the file has none. Only an active set resolves its tokens, so keep it active.

| Penpot token type | Bridged as |
| --- | --- |
| `color` | color (alpha kept; written back as `#rrggbb` or `#rrggbbaa`) |
| `number`, `dimension`, `opacity`, `rotation`, `sizing`, `spacing`, `borderWidth`, `borderRadius`, `fontSizes`, `letterSpacing` | number |
| `fontWeights`, `fontFamilies`, `textCase`, `textDecoration` | text |
| `shadow`, `typography` | not bridged |

Penpot has no boolean tokens. Use a `number` token with `0` and `1` instead.

## Pairing

Open **MQTT settings** in the plugin and enter the same Bridge ID and broker that Microflow
Studio shows. The default broker is `wss://test.mosquitto.org:8081/mqtt`.

## Develop

```sh
bun run dev
```

In Penpot, open the plugin manager and install `http://localhost:5173/manifest.json`. The dev server serves the manifest, `plugin.js`,
`icon.png` and the UI with CORS enabled, and rebuilds `plugin.js` on every load.

```sh
bun run check-types
```

## Build

```sh
bun run build
```

`dist/` holds `manifest.json`, `plugin.js`, `icon.png` and `ui/`. The manifest is a
version 2 manifest: Penpot resolves every path in it relative to the manifest's own URL, so
you can serve `dist/` from any path, as long as the server sends CORS headers.
