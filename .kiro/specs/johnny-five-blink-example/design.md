# Design Document: Johnny-Five Blink Example

## Overview

This document describes the design for integrating Johnny-Five microcontroller control into the microflow-t-stack application. The feature will enable the Tauri desktop application to connect to Arduino-compatible microcontrollers and control an LED on pin 13.

Since Johnny-Five requires Node.js and direct serial port access (which browsers cannot provide), the implementation will use **Tauri's sidecar feature** to run a separate Node.js process that handles the hardware communication. The Tauri app will communicate with this sidecar process via IPC commands.

For the web application, hardware control will not be available (as it requires native serial port access). The UI will detect the platform and show appropriate messaging.

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Tauri Desktop App                      │
│  ┌──────────────────────────────────────────────────┐  │
│  │         React Frontend (Renderer)                │  │
│  │  - Hardware control UI components                │  │
│  │  - Invokes Tauri commands                        │  │
│  └────────────────────┬─────────────────────────────┘  │
│                       │ Tauri IPC                       │
│  ┌────────────────────▼─────────────────────────────┐  │
│  │         Rust Backend (Tauri Core)                │  │
│  │  - Tauri commands (connect, blink, etc.)        │  │
│  │  - Manages sidecar process lifecycle            │  │
│  │  - Forwards commands to Node.js sidecar         │  │
│  └────────────────────┬─────────────────────────────┘  │
│                       │ Child Process IPC               │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│          Node.js Sidecar Process (Worker)               │
│  ┌──────────────────────────────────────────────────┐  │
│  │      Hardware Service                            │  │
│  │  - Board connection management                   │  │
│  │  - LED control                                   │  │
│  │  - State management                              │  │
│  │  - Listens for commands from Tauri              │  │
│  └────────────────────┬─────────────────────────────┘  │
│                       │                                 │
│  ┌────────────────────▼─────────────────────────────┐  │
│  │      Johnny-Five Library                         │  │
│  │  - Board abstraction                             │  │
│  │  - LED component                                 │  │
│  └────────────────────┬─────────────────────────────┘  │
└───────────────────────┼─────────────────────────────────┘
                        │
              Serial Communication (USB)
                        │
┌───────────────────────▼─────────────────────────────────┐
│         Arduino Microcontroller                         │
│         (Running StandardFirmata)                       │
└─────────────────────────────────────────────────────────┘
```

### Component Responsibilities

1. **React Frontend**: UI components for hardware control, invokes Tauri commands
2. **Tauri Rust Backend**: Manages the Node.js sidecar process, forwards commands via stdin/stdout
3. **Node.js Sidecar (Worker)**: Runs Johnny-Five, manages board connection and LED control
4. **Johnny-Five Board**: Manages the connection to the microcontroller
5. **Johnny-Five LED**: Provides high-level LED control methods (blink, toggle, on, off)

### Why This Architecture?

- **Johnny-Five requires Node.js**: Cannot run in browser or Rust
- **Serial port access**: Requires native system access (not available in web)
- **Tauri sidecar**: Allows bundling a Node.js executable with the app
- **Process isolation**: Hardware control runs in separate process, won't block UI
- **IPC communication**: Tauri backend communicates with sidecar via stdin/stdout

## Components and Interfaces

### Tauri Commands (Rust)

Tauri commands will be added to `apps/web/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn hardware_connect(port: Option<String>) -> Result<HardwareResponse, String> {
  // Send "connect" command to sidecar process
  // Returns: { success: bool, message: String }
}

#[tauri::command]
async fn hardware_start_blink(pin: u8, interval: u32) -> Result<HardwareResponse, String> {
  // Send "startBlink" command to sidecar process
  // Returns: { success: bool, message: String }
}

#[tauri::command]
async fn hardware_stop_blink() -> Result<HardwareResponse, String> {
  // Send "stopBlink" command to sidecar process
  // Returns: { success: bool, message: String }
}

#[tauri::command]
async fn hardware_disconnect() -> Result<HardwareResponse, String> {
  // Send "disconnect" command to sidecar process
  // Returns: { success: bool, message: String }
}

#[tauri::command]
async fn hardware_get_status() -> Result<HardwareStatus, String> {
  // Send "getStatus" command to sidecar process
  // Returns: { connected: bool, blinking: bool, pin?: u8, interval?: u32 }
}
```

### Node.js Sidecar (Worker)

The sidecar will be created at `apps/web/src-tauri/sidecar/hardware-worker.js`:

```javascript
// Listens for commands on stdin, sends responses on stdout
// Command format: JSON { type: "connect" | "startBlink" | "stopBlink" | "disconnect" | "getStatus", ...args }
// Response format: JSON { success: bool, message?: string, data?: any }

class HardwareWorker {
  constructor() {
    this.board = null;
    this.led = null;
    this.isConnected = false;
    this.isBlinking = false;
    this.currentPin = null;
    this.currentInterval = null;
  }
  
  async handleCommand(command) {
    switch (command.type) {
      case 'connect':
        return await this.connect(command.port);
      case 'startBlink':
        return await this.startBlink(command.pin, command.interval);
      case 'stopBlink':
        return await this.stopBlink();
      case 'disconnect':
        return await this.disconnect();
      case 'getStatus':
        return this.getStatus();
    }
  }
  
  async connect(port) { /* ... */ }
  async startBlink(pin, interval) { /* ... */ }
  async stopBlink() { /* ... */ }
  async disconnect() { /* ... */ }
  getStatus() { /* ... */ }
}

// Listen for commands on stdin
process.stdin.on('data', async (data) => {
  const command = JSON.parse(data.toString());
  const response = await worker.handleCommand(command);
  process.stdout.write(JSON.stringify(response) + '\n');
});
```

### React Components

React components will be created in `apps/web/src/components/hardware/`:

```typescript
// HardwareControl.tsx
import { invoke } from '@tauri-apps/api/core';

export function HardwareControl() {
  const [status, setStatus] = useState<HardwareStatus | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const result = await invoke('hardware_connect', { port: null });
      // Update UI based on result
    } catch (error) {
      // Show error toast
    } finally {
      setIsConnecting(false);
    }
  };
  
  const handleStartBlink = async () => {
    try {
      await invoke('hardware_start_blink', { pin: 13, interval: 500 });
      // Update UI
    } catch (error) {
      // Show error toast
    }
  };
  
  // ... other handlers
  
  return (
    <div>
      {/* UI for controlling hardware */}
    </div>
  );
}
```

### Platform Detection

```typescript
// utils/platform.ts
import { platform } from '@tauri-apps/plugin-os';

export function isDesktop(): boolean {
  try {
    return platform() !== 'web';
  } catch {
    return false; // Running in web browser
  }
}
```

## Data Models

### Command/Response Protocol (Sidecar IPC)

```typescript
// Commands sent from Tauri to sidecar (via stdin)
type SidecarCommand = 
  | { type: 'connect', port?: string }
  | { type: 'startBlink', pin: number, interval: number }
  | { type: 'stopBlink' }
  | { type: 'disconnect' }
  | { type: 'getStatus' };

// Responses sent from sidecar to Tauri (via stdout)
interface SidecarResponse {
  success: boolean;
  message?: string;
  data?: any;
}
```

### Tauri Types (Rust)

```rust
#[derive(serde::Serialize, serde::Deserialize)]
struct HardwareResponse {
    success: bool,
    message: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct HardwareStatus {
    connected: bool,
    blinking: bool,
    pin: Option<u8>,
    interval: Option<u32>,
}
```

### React Types (TypeScript)

```typescript
interface HardwareStatus {
  connected: boolean;
  blinking: boolean;
  pin?: number;
  interval?: number;
}

interface HardwareResponse {
  success: boolean;
  message: string;
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Board Connection and Ready Event
*For any* application start with an available microcontroller, the Board instance should successfully establish a serial connection and emit a 'ready' event within a reasonable timeout period.

**Validates: Requirements 1.1, 1.2, 1.3, 3.1**

### Property 2: LED Creation and Blink Activation
*For any* ready Board instance, creating an LED component on pin 13 and starting the blink pattern should succeed, resulting in an LED that toggles state.

**Validates: Requirements 2.1, 2.2**

### Property 3: Configurable Blink Interval
*For any* valid blink interval value (in milliseconds), the LED should toggle between on and off states at that specified interval with reasonable timing accuracy.

**Validates: Requirements 2.3, 2.4**

### Property 4: Graceful Shutdown and Cleanup
*For any* running application, when a termination signal (SIGINT, SIGTERM) is received, the application should stop the LED blinking, close the board connection, and exit with status code 0.

**Validates: Requirements 2.5, 3.3, 3.4, 3.5**

### Property 5: Error Handling and Logging
*For any* connection failure or error condition, the application should log a descriptive error message with context and exit gracefully without hanging.

**Validates: Requirements 1.4, 1.5, 4.4**

### Property 6: Success Logging
*For any* successful board connection, the application should log appropriate status messages including "Connecting to board...", "Board connected successfully", and "LED on pin 13 is blinking".

**Validates: Requirements 3.2, 4.1, 4.2, 4.3**

## Error Handling

### Connection Errors

**No Board Found:**
- Sidecar returns: `{ success: false, message: "No Arduino board found. Please check connection." }`
- UI shows error toast

**Connection Timeout:**
- Sidecar returns: `{ success: false, message: "Connection timeout. Board may not be running StandardFirmata." }`
- UI shows error toast

**Serial Port Error:**
- Sidecar returns: `{ success: false, message: "Unable to open serial port: [error details]" }`
- UI shows error toast

**Already Connected:**
- Sidecar returns: `{ success: false, message: "Board is already connected. Disconnect first." }`
- UI shows warning toast

### Runtime Errors

**LED Initialization Error:**
- Sidecar returns: `{ success: false, message: "Failed to initialize LED on pin [pin]: [error details]" }`
- UI shows error toast

**Not Connected:**
- Sidecar returns: `{ success: false, message: "Board is not connected. Connect first." }`
- UI shows warning toast

**Already Blinking:**
- Sidecar returns: `{ success: false, message: "LED is already blinking. Stop first." }`
- UI shows warning toast

### Sidecar Process Errors

**Sidecar Crash:**
- Tauri detects sidecar process exit
- Attempt to restart sidecar
- Show error notification to user

**Communication Error:**
- Timeout waiting for sidecar response (5 seconds)
- Show error toast
- Offer to restart sidecar

### Cleanup Strategy

The sidecar worker will implement proper cleanup:
1. Stop LED blinking if active
2. Close board connection if open
3. Reset internal state
4. Send success response

Tauri will handle sidecar lifecycle:
1. Start sidecar on app launch (lazy start on first hardware command)
2. Monitor sidecar health
3. Kill sidecar on app exit
4. Restart sidecar if it crashes

### Client Error Handling

React components will:
1. Display error messages using toast notifications (sonner)
2. Disable controls during operations (loading states)
3. Show connection status clearly
4. Provide retry mechanisms for failed operations
5. Show "Desktop only" message in web browser

## Testing Strategy

### Unit Tests

Unit tests will verify specific behaviors and edge cases:

1. **Sidecar Command Parsing**: Test JSON command parsing and validation
2. **State Management**: Test state transitions (disconnected → connected → blinking)
3. **Error Response Formatting**: Verify error messages contain expected information
4. **Platform Detection**: Test isDesktop() function in web and Tauri contexts

### Property-Based Tests

Property-based tests will verify universal properties across many scenarios using fast-check:

1. **Property 1 - Board Connection**: Generate various port configurations and verify successful initialization
2. **Property 2 - LED Creation**: Test LED component creation with different pin configurations
3. **Property 3 - Blink Timing**: Verify blink interval timing accuracy across different interval values
4. **Property 4 - State Consistency**: Test that sidecar state remains consistent across operations
5. **Property 5 - Error Handling**: Generate error conditions and verify proper error responses
6. **Property 6 - Command Serialization**: Test that all commands serialize/deserialize correctly

**Configuration:**
- Minimum 100 iterations per property test
- Each test tagged with: **Feature: johnny-five-blink-example, Property {N}: {property text}**

### Integration Tests

Integration tests will verify end-to-end functionality:

1. **Tauri-Sidecar Communication**: Test command/response flow between Tauri and sidecar
2. **Board Auto-Detection**: Test with and without explicit port specification
3. **UI Integration**: Test React components with mocked Tauri commands
4. **Error Recovery**: Test behavior when board is disconnected during operation
5. **Sidecar Restart**: Test that sidecar can be restarted after crash

### Testing Approach

- Use Vitest for TypeScript/JavaScript tests
- Use Rust's built-in test framework for Tauri command tests
- Use fast-check for property-based testing
- Mock Johnny-Five Board and LED for unit tests
- Use a test board or simulator for integration tests
- Test sidecar in isolation (can run standalone)
- Aim for >80% code coverage

### Manual Testing

Manual testing will verify:
1. Physical LED blinks on actual Arduino board
2. UI responsiveness during operations
3. Error messages are user-friendly
4. Web app shows "Desktop only" message
5. Tauri app works on macOS, Windows, Linux

## Implementation Notes

### Dependencies

```json
{
  "dependencies": {
    "johnny-five": "^2.1.0"
  },
  "devDependencies": {
    "@types/johnny-five": "^1.4.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "fast-check": "^3.0.0"
  }
}
```

### File Structure

```
johnny-five-blink/
├── src/
│   └── index.ts          # Main application
├── tests/
│   ├── unit/
│   │   └── index.test.ts # Unit tests
│   └── properties/
│       └── index.prop.test.ts # Property-based tests
├── package.json
├── tsconfig.json
├── jest.config.js
└── README.md
```

### TypeScript Configuration

- Target: ES2020
- Module: CommonJS (for Node.js compatibility)
- Strict mode enabled
- Source maps enabled for debugging

### Execution

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run application
npm start

# Run tests
npm test
```

## Future Enhancements

While not part of this minimal example, potential enhancements could include:

1. Command-line arguments for configuration (port, interval, pin)
2. Support for multiple LEDs
3. Different blink patterns (fade, pulse, morse code)
4. Web interface for remote control
5. Configuration file support

These enhancements are explicitly out of scope for this minimal example.
