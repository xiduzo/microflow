---
title: Getting started
---

A desktop application that allows you to create interactive prototypes using a visual, flow-based, interface. {% .lead %}

Download the [latest release](https://github.com/xiduzo/microflow/releases) to get started.

---

## Connect your microcontroller

Microflow studio should automatically detect your microcontroller when connected to your computer. It will run through the following steps:

1. Waiting for a microcontroller to be connected to your computer
2. Detecting the type of microcontroller.
{% callout type="note" title="Be patient" %}
To be able to communicate with your microcontroller, Microflow will automatically install special software (called StandardFirmata) on your microcontroller in this step. This software allows your computer to talk to the microcontroller.

This will only happen the first time you connect your microcontroller, and will take some time (usually 30-60 seconds). Please don't disconnect your microcontroller during this process.
{% /callout %}
3. Uploading your flow.
4. Running your flow.

If your microcontroller does not reach step 4 automatically, your microcontroller might either not be [supported](#supported-microcontroller-boards) or having [issues connecting](#not-connecting).

### Supported microcontroller boards

As of right now Microflow studio support the following boards officially:

- Arduino uno
- Arduino mega
- Arduino leonardo
- Arduino micro
- Arduino nano
- Arduino yun

[Other boards](https://johnny-five.io/platform-support/) might connected but can give unexpected results.

### Not connecting?

Oops, something might be going on with your microcontroller.

You should see the `Upload failed for unknown reasons` status.

In order to validate if the problem is with your microcontroller or with Microflow studio, you can try the following:

#### 1. Check your microcontroller
First, let's make sure your microcontroller is working properly by testing it with the Arduino IDE (a free program for working with Arduino boards).

1. Install [the latest Arduino IDE](https://www.arduino.cc/en/software) (it's free)
2. Open the Arduino IDE and connect your microcontroller to your computer
3. Go to `Tools > Port` and select the port where your microcontroller is connected (you should see it listed)
4. Go to `Tools > Board` and select the board you are using (like "Arduino Uno")
5. Go to `File > Examples > Firmata > StandardFirmata` (this opens a ready-made program)
6. Click the `Upload` button (arrow icon) to send the program to your microcontroller

If you can successfully upload the program to your microcontroller, then your hardware is working fine and the problem might be with Microflow studio. If you can't upload, there might be an issue with your microcontroller or its connection.

#### 2. Install the correct drivers

If you are using an unofficial board, you might still need to install the correct drivers for your specific board.

This is a common issue for Arduino clones which require the _CH34x driver_. You can find the driver [here](https://sparks.gogo.co.nz/ch340.html), and check [this youtube video](https://www.youtube.com/watch?v=MM9Fj6bwHLk) for instructions on how to install the driver on your machine

---

If non of the sollutions above work, you can help us by sharing your log file with us in [a new bug report](https://github.com/xiduzo/microflow/issues/new?assignees=&labels=&projects=&template=bug_report.md&title=).

The log file should be located at:

| OS      | Log file path |
|---------|---------------|
| Linux   | ~/.config/microflow-studio/logs/main.log |
| macOS   | ~/Library/Logs/microflow-studio/main.log |
| Windows | %USERPROFILE%\AppData\Roaming\microflow-sudio\logs\main.log |
