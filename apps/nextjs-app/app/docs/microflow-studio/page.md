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

If your microcontroller does not reach step 4 automatically, your microcontroller might either not be [supported](#supported-microcontroller-boards) or having [issues connecting](#not-connecting).

### Supported microcontroller boards

While Johnny-Five supports a broad range of boards, as of right now Microflow studio support the following boards

- Arduino uno
- Arduino mega
- Arduino leonardo
- Arduino micro
- Arduino nano
- Arduino yun

### Not connecting?

Oops, something might be going on with your microcontroller.

When the You should see a `Upload failed for unknown reasons` status.

In order to validate if the problem is with your microcontroller or with Microflow studio, you can try the following:

#### 1. Check your microcontroller

1. Install [the latests Arduino IDE](https://www.arduino.cc/en/software)
2. Open the Arduino IDE and connect your microcontroller
3. Go to `Tools > Port` and select the port where your microcontroller is connected
4. Go to `Tools > Board` and select the board you are using
5. Go to `File > Examples > Firmata > StandardFirmata`
6. `Upload` the sketch to your microcontroller

If you can successfully upload the sketch to your microcontroller, then the problem is with Microflow studio (ooops).

#### 2. Install the correct drivers

If you are using an unofficial board, you might need to install the correct drivers for your board.

A common example is the _CH34x driver_ for Arduino clones. You can find the driver [here](https://sparks.gogo.co.nz/ch340.html), and check [this youtube video](https://www.youtube.com/watch?v=MM9Fj6bwHLk) for instructions on how to install the driver.

---

If non of the sollutions above work, you can help us by sharing your log file with us in [a new bug report](https://github.com/xiduzo/microflow/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=).

The log file should be located at:

| OS      | Log file path |
|---------|---------------|
| Linux   | ~/.config/microflow-studio/logs/main.log |
| macOS   | ~/Library/Logs/microflow-studio/main.log |
| Windows | %USERPROFILE%\AppData\Roaming\microflow-sudio\logs\main.log |
