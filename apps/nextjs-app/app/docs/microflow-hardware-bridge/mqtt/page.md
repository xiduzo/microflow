---
title: MQTT
---

Microflow hardware bridge is relying on [MQTT](https://mqtt.org) to send and receive updates for Figma variables.

By default it will be connected to the [mosquitto](https://mosquitto.org/) test broker, please do not abuse this awesome free service.

## Data security

Because the default connection is connected to an open broker, all data is public and can be read by anyone. Be aware to not publish any sensitive content over this connection.

### Local broker
Figma requires the broker to be connected over a secure connection (`wss`).

To connect to a local broker, you will need to make sure you have a valid SSL certificate.

Tool like [caddy](https://hub.docker.com/_/caddy) or [nginx](https://hub.docker.com/_/nginx) can help you to create a local secure connection.

---

To ensure your data comming through, or is hidden from the world, you can connect the plugin to your own broker of choice.

## Resources

- [mqtt.org](https://mqtt.org/)
