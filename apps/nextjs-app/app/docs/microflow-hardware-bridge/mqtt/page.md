---
title: MQTT
---

Microflow hardware bridge is relying on [MQTT](https://mqtt.org) to send and receive updates for Figma variables.

By default it will be connected to the [mosquitto](https://mosquitto.org/) test broker, please do not abuse this awesome free service.

Because the default connection is connected to an open broker, all data is public and can be read by anyone.

---

To ensure your data comming through, or is hidden from the world, you can connect the plugin to your own broker of choice.

## Resources

- [mqtt.org](https://mqtt.org/)
