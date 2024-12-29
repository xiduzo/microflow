---
title: MQTT
---

{% tags %}
{% tag title="Input" /%}
{% tag title="Output" /%}
{% /tags %}

The MQTT node allows you to send and receive messages from any MQTT broker.

By default it will be connected to the [mosquitto](https://mosquitto.org/) test broker, please do not abuse this awesome free service.

Configuring MQTT can be done via `Settings > MQTT settings`.

| Config | What is it for |
| --- | ---|
| Identifier | This makes you unique and allows you to only receive messages you need  |
| Host | The address of the MQTT broker. [List of free MQTT brokers](https://iot4beginners.com/top-15-open-source-public-free-brokers-of-mqtt/) |
| Port | As documented in the MQTT broker of your liking |
| Username | _Sometimes a broker requires a username_ |
| Password | _Sometimes a broker requires a password_ |


---

Because the default connection is connected to an open broker, all data is public and can be read by anyone.

To ensure your data comming through, or is hidden from the world, you can connect the plugin to your own broker of choice.

---

When using a [Figma nodes](/docs/microflow-studio/nodes/figma), make sure to configure the same broker in both [Microflow Studio](/docs/microflow-studio) and [Microflow hardware bridge](/docs/microflow-hardware-bridge).

## Resources

- [mqtt.org](https://mqtt.org/)
