---
title: Getting started
---

A desktop application that allows you to create interactive prototypes using a visual, flow-based, interface. {% .lead %}

Download the [latest release](https://github.com/xiduzo/microflow/releases) to get started.

---

## Connect your microcontroller

Microflow studio is nothing more than a _fancy_ wrapper around the [Johnny-Five](https://johnny-five.io/) platform. Microflow studio should automatically detect your microcontroller and connect to it following the steps below.

1. Waiting for a microcontroller to be connected to your computer
2. Detecting the type of microcontroller.
{% callout type="note" title="Be patient" %}
To be able to communicate with your microcontroller we will automatically install the [StandardFirmata](https://github.com/firmata/arduino) sketch on your microcontroller in this step.

This will only happen the first time you connect your microcontroller, and will take some time.
{% /callout %}
3. Uploading your flow.
4. Running your flow.

If your microcontroller does not reach step 4 automatically, your microcontroller might not be supported yet.

### Supported microcontroller boards

While Johnny-Five supports a broad range of boards, as of right now Microflow studio support the following boards

- Arduino uno
- Arduino mega
- Arduino leonardo
- Arduino micro
- Arduino nano
- Arduino yun

### Not connecting?

Oops, something might be going on with your microcontroller. We keep a log file to validate what's going on, you could help us by sharing this log in [a new bug report](https://github.com/xiduzo/microflow/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=).

The log file should be located at:

| OS      | Log file path |
|---------|---------------|
| Linux   | ~/.config/microflow-studio/logs/main.log |
| macOS   | ~/Library/Logs/microflow-studio/main.log |
| Windows | %USERPROFILE%\AppData\Roaming\microflow-sudio\logs\main.log |
