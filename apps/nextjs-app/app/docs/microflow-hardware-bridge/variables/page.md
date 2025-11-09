---
title: Variables
---

The Microflow Hardware Bridge uses [MQTT](/docs/microflow-hardware-bridge/mqtt) (a messaging system) to connect your Figma variables with your hardware projects.

**Important:** For this to work, both Microflow Studio and the Figma plugin must be connected to the same MQTT broker (message server). Think of it like they need to be on the same "channel" to talk to each other. {% .text-orange-500 %}

## {% icon name="ServerCog" /%} Configure MQTT

To connect your hardware and Figma, you need to configure MQTT settings. Here's what each setting does:

| Setting | What it does |
| --- | ---|
| **Identifier** | A unique name for your connection. This helps make sure you only receive messages meant for you, especially if multiple people are using the same MQTT server. Think of it like a unique username. |
| **Host** | The address of the MQTT server (broker). This is like the address of a post office where messages are sent and received. You can use a free public server or set up your own. [List of free MQTT brokers](https://iot4beginners.com/top-15-open-source-public-free-brokers-of-mqtt/) |
| **Port** | The port number for the MQTT server. This is usually 1883 for regular connections or 8883 for secure connections. The MQTT server documentation will tell you which port to use. |
| **Username** | Some MQTT servers require a username to connect. If the server you're using doesn't require one, you can leave this blank. |
| **Password** | Some MQTT servers require a password to connect. If the server you're using doesn't require one, you can leave this blank. |
