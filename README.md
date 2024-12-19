# Microflow

A set of tools to make it easier to start prototyping for interactivity.

Microflow consists of 2 applications so far:

1. Microflow studio
2. Microflow hardware bridge (Figma plugin)

[See the documentation](https://microflow.vercel.app/docs)

## Microflow studio

A desktop application that allows you to create interactive prototypes using a visual, flow-based, interface.

Download the latest release from the [releases page](https://github.com/xiduzo/microflow/releases) and get started.

## Microflow hardware bridge

Bridge the gap between your microcontrollers and design tools.

Microflow hardware bridge is a [Figma plugin](https://www.figma.com/community/plugin/1373258770799080545) that allows you to connect your Figma designs to the Microflow studio application or any other application that supports MQTT.

# Running the project locally

This project is a mono-repo that contains the Microflow studio and the Microflow hardware bridge.

It uses [Yarn workspaces](https://classic.yarnpkg.com/en/docs/workspaces/) to manage dependencies.


## Microflow studio

1. run `yarn install`
2. run `yarn dev`

### Firmata versions

Microflow studio will flash firmata to your microcontroller automatically.

For the [supported boards](https://microflow.vercel.app/docs/microflow-studio#supported-microcontroller-boards) it will flash version `2.5.X` to be compatible with touchdesigner.

All other boards will get flashed with version `2.4.X` from [avr-girl-arduino](https://github.com/noopkat/avrgirl-arduino/tree/master/junk/hex).

## Microflow hardware bridge

1. run `yarn install`
2. run `yarn dev:plugin`

# Development and contributing
See the [wiki](https://github.com/xiduzo/microflow/wiki) to get started contributing to `microflow`
