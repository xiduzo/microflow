# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Microflow, please report
it **privately** — do not open a public issue.

Email **mail@sanderboer.nl** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected component, version, or commit.

You can expect an acknowledgement within **5 business days** and, where the report
is valid, a remediation plan and a coordinated disclosure timeline. We will credit
reporters who wish to be named once a fix is released.

## Scope

Microflow runs partly on the user's own machine (desktop app, browser with Web
Serial) and connects to hardware and to cloud endpoints the user configures
(LLM providers, MQTT brokers, and the Figma and Penpot plugins). Of particular interest:

- handling of user-supplied **credentials** (broker passwords, API keys),
- the **serial / Firmata** transport and device interaction,
- **cloud** request handling (LLM/MQTT/Figma) and the browser's direct-to-endpoint
  calls,
- the **design-tool bridge**: the Figma and Penpot plugins and the MQTT protocol they
  share with Studio (`packages/design-bridge`),
- the **collaboration** sync layer.

Note: by design, the browser host talks **directly** to the cloud endpoints a user
configures (no proxy — see [ADR-0009](docs/adr/0009-cloud-sans-io-capability.md));
users are responsible for the endpoints they point Microflow at.

## Design-tool plugins: known properties

The Figma and Penpot plugins link a design file to Studio over an MQTT broker the
user chooses ([ADR-0028](docs/adr/0028-design-tool-bridge-protocol.md)). By design:

- **The Bridge ID is the only separation on a shared broker.** Every bridge topic is
  `microflow/{bridgeId}/…`. On a public broker, such as the plugins' default
  `test.mosquitto.org`, anyone who knows or guesses a Bridge ID can read the variable
  list (retained on the broker) and the values, and can publish `set` messages that
  change the open design file. Studio's default Bridge ID is derived from the account
  display name, so it is guessable. Use a private broker with authentication for
  anything sensitive.
- **Broker credentials are stored in plain text.** The Figma plugin keeps its broker
  URL, username and password in Figma's `clientStorage`; the Penpot plugin keeps them
  in the `localStorage` of its UI page.
- **The Figma plugin may reach any domain.** Its manifest sets `networkAccess.allowedDomains`
  to `["*"]`, so it can connect to whichever broker the user enters.
- **Certificate checks.** The plugins' MQTT client
  (`packages/design-bridge/src/mqtt-broker.ts`) opens every connection on the
  platform's own WebSocket (`forceNativeWebSocket`) and sets no TLS option, so the
  platform checks the broker's certificate: the browser in a plugin, and bun in tests.

## Supported versions

Microflow is under active development. Security fixes target the latest release and
`main`. Older versions are not maintained.

## Out of scope

Vulnerabilities in third-party hardware, user-configured brokers/LLM endpoints, or
the user's own network are outside this project's control, though we're happy to
hear about issues that affect how Microflow interacts with them.
