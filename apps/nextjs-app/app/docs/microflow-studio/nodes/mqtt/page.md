---
title: MQTT
---

{% tags %}
{% tag title="Input" /%}
{% tag title="Output" /%}
{% /tags %}

The MQTT node allows you to send and receive messages from any MQTT broker.

By default it will be connected to the [mosquitto](https://mosquitto.org/) test broker, please do not abuse this awesome free service.

Because the default connection is connected to an open broker, all data is public and can be read by anyone.

---

To ensure your data comming through, or is hidden from the world, you can connect the plugin to your own broker of choice.

---

When using a [Figma nodes](/docs/microflow-studio/nodes/figma), make sure to configure the same broker in both [Microflow Studio](/docs/microflow-studio) and [Microflow hardware bridge](/docs/microflow-hardware-bridge).

## Resources

- [mqtt.org](https://mqtt.org/)
