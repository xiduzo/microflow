---
title: Nodes
---

Nodes are the building blocks of any flow.

They are the basic units of computation and can be connected to each other to form a flow. Nodes can be of different types, such as input, output, or processing nodes. Each node has a set of properties that define its behavior and configuration.

By connecting nodes together, using [edges](/docs/microflow-studio/edges), you can create complex interactions that perform a wide range of tasks.

For example, you can create a flow that reads data from a sensor, processes the data, and then sends the result to an output device.

## Atonomy of a Node

Nodes are being connected with [edges](/docs/microflow-studio/edges) to form a flow. Each node has a set of handles that can be connected to other nodes.

![Visual representation of the atonomy of a node](/images/node-atonomy.svg)

Input handles {% .text-blue-500 .font-bold %}

A node can have 0 or more input handles. Other nodes can connect to these handles to provide input to the node. This input can trigger an action or change the node's value.

Output handles {% .text-green-500 .font-bold %}

A node can have 0 or more output handles. These handles are used to connect the node to other nodes.

Change handle {% .text-rose-300 .font-bold %}

Some nodes have a change handle that allows you to do something when the node value changes.

Node value {% .text-yellow-500 .font-bold %}

The value of a node can be represented in different ways, depending on the node type. This could either be a number, a string, a toggle switch, or a color.

### Node properties

Each node has a set of properties that define its behavior and configuration. These properties can be set in the node's configuration panel.

To open the configuration panel, **double-click** on the node in the flow editor.
