---
title: MQTT
---

The Microflow Hardware Bridge uses [MQTT](https://mqtt.org) (Message Queuing Telemetry Transport) to send and receive messages between your Figma designs and your hardware projects. Think of MQTT as a messaging system that lets different programs talk to each other.

By default, the plugin connects to a free public MQTT server called [mosquitto](https://mosquitto.org/). This is great for testing, but please be respectful and don't overload this free service with too many messages.

## Data security

**Important:** The default public MQTT server is open to everyone, which means anyone can see the messages you're sending. This is fine for testing and non-sensitive projects, but **do not send any private, personal, or sensitive information** over this connection.

If you're working with sensitive data or want privacy, you should set up your own private MQTT server (see below).

### Setting up your own private MQTT server

If you want to keep your data private or need more control, you can set up your own MQTT server. This is more advanced but gives you complete privacy and control.

**Requirements:** Figma requires a secure connection (called `wss` - WebSocket Secure) to connect to MQTT servers. This means you need an SSL certificate (like the security certificates used by websites).

**Tools that can help:** If you're comfortable with technical setup, tools like [caddy](https://hub.docker.com/_/caddy) or [nginx](https://hub.docker.com/_/nginx) can help you create a secure local connection. This is recommended for production use or when working with sensitive data.

**Why set up your own server?** Your own server ensures your data stays private and gives you full control over who can access it.

## Resources

- [mqtt.org](https://mqtt.org/)
