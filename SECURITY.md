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
(LLM providers, MQTT brokers, Figma). Of particular interest:

- handling of user-supplied **credentials** (broker passwords, API keys),
- the **serial / Firmata** transport and device interaction,
- **cloud** request handling (LLM/MQTT/Figma) and the browser's direct-to-endpoint
  calls,
- the **collaboration** sync layer.

Note: by design, the browser host talks **directly** to the cloud endpoints a user
configures (no proxy — see [ADR-0009](docs/adr/0009-cloud-sans-io-capability.md));
users are responsible for the endpoints they point Microflow at.

## Supported versions

Microflow is under active development. Security fixes target the latest release and
`main`. Older versions are not maintained.

## Out of scope

Vulnerabilities in third-party hardware, user-configured brokers/LLM endpoints, or
the user's own network are outside this project's control, though we're happy to
hear about issues that affect how Microflow interacts with them.
