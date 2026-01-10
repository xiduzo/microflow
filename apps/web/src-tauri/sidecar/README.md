# Hardware Worker Sidecar

This is a Node.js sidecar process that runs alongside the Tauri application to provide Johnny-Five hardware control capabilities.

## Overview

The hardware worker communicates with the Tauri application via stdin/stdout using JSON messages. It manages the connection to Arduino microcontrollers and controls hardware components like LEDs.

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run the worker (for testing)
npm start
```

## Architecture

The sidecar runs as a separate Node.js process and:
- Listens for commands on stdin (JSON format)
- Executes hardware operations using Johnny-Five
- Sends responses on stdout (JSON format)
- Manages board connection state and LED control

## Requirements

- Node.js 18+
- Arduino board running StandardFirmata
- USB connection to the Arduino

## Command Protocol

Commands are sent as JSON objects via stdin:

```json
{ "type": "connect", "port": "/dev/ttyUSB0" }
{ "type": "startBlink", "pin": 13, "interval": 500 }
{ "type": "stopBlink" }
{ "type": "disconnect" }
{ "type": "getStatus" }
```

Responses are sent as JSON objects via stdout:

```json
{ "success": true, "message": "Board connected" }
{ "success": false, "message": "Error: No board found" }
```
