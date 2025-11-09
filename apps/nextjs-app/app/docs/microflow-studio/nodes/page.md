---
title: Nodes
---

Nodes are the building blocks of any flow. Think of them as puzzle pieces that you can connect together to create interactive projects.

Each node does a specific job - some read information (like a button press or sensor reading), some control things (like turning on a light), and some process information (like doing math or making decisions). You can connect nodes together using [edges](/docs/microflow-studio/edges) to create a flow of information and actions.

For example, you can create a flow that reads data from a sensor, processes the data, and then sends the result to an output device like an LED light.

{% quick-links %}

{% quick-link title="Input nodes" href="/docs/microflow-studio/nodes/input" description="Read data from sensors, buttons, and external services." /%}
{% quick-link title="Output nodes" href="/docs/microflow-studio/nodes/output" description="Control hardware components and send data to external services." /%}
{% quick-link title="Event nodes" href="/docs/microflow-studio/nodes/event" description="Generate or respond to events in your flow." /%}
{% quick-link title="Generator nodes" href="/docs/microflow-studio/nodes/generator" description="Produce values and signals for your flow." /%}
{% quick-link title="Transformation nodes" href="/docs/microflow-studio/nodes/transformation" description="Modify and process data in your flow." /%}
{% quick-link title="Control nodes" href="/docs/microflow-studio/nodes/control" description="Manage data flow and make decisions." /%}
{% quick-link title="Information nodes" href="/docs/microflow-studio/nodes/information" description="Document, monitor, and visualize your flow." /%}


{% /quick-links %}


## Parts of a Node

Nodes are connected with [edges](/docs/microflow-studio/edges) (the lines between nodes) to form a flow. Each node has connection points called "handles" where you can attach edges to connect nodes together.

![Visual representation of the atonomy of a node](/images/node-atonomy.svg)

Input handles {% .text-blue-500 .font-bold %}

These are the connection points on the left side of a node (shown in blue). You connect other nodes to these handles to send information or signals into the node. For example, you might connect a button node to an LED node's input handle so the LED turns on when the button is pressed.

Output handles {% .text-green-500 .font-bold %}

These are the connection points on the right side of a node (shown in green). These send information or signals out to other nodes. Each node has different types of outputs depending on what it does. For example, a button node might have an "on" output and an "off" output.

Node value {% .text-yellow-500 .font-bold %}

This is the visual display in the center of the node that shows what the node is currently doing or what value it has. This could be a number, a switch that's on or off, a color, an icon, or other visual indicators. It helps you see what's happening in your flow at a glance.

Settings {% .text-gay-400 .font-bold %}

You can customize how each node works by clicking the settings icon (usually in the top right corner of the node). This lets you change things like which pin a sensor is connected to, how fast something happens, or what values to use.
