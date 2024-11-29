---
title: Variables
---

Microflow hardware bridge is using [MQTT](/docs/microflow-hardware-bridge/mqtt) to be able to interact with your Figma variables.

In order to work with variables make sure your client is connected to the same MQTT broker as configured in the plugin. {% .text-orange-500 %}

## {% icon name="ServerCog" /%} Configure MQTT

| Config | What is it for |
| --- | ---|
| Identifier | This makes you unique and allows you to only receive messages you need  |
| Host | The address of the MQTT broker. [List of free MQTT brokers](https://iot4beginners.com/top-15-open-source-public-free-brokers-of-mqtt/) |
| Port | As documented in the MQTT broker of your liking |
| Username | _Sometimes a broker requires a username_ |
| Password | _Sometimes a broker requires a password_ |
