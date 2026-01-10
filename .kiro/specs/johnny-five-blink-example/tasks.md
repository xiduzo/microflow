# Implementation Plan: Johnny-Five Blink Example

## Overview

This implementation plan breaks down the Johnny-Five blink example feature into discrete tasks. The feature enables Tauri desktop users to connect to Arduino microcontrollers and blink an LED on pin 13. The implementation uses a Node.js sidecar process to run Johnny-Five, with Tauri commands handling IPC communication.

## Tasks

- [x] 1. Set up Node.js sidecar infrastructure
  - Create sidecar directory structure at `apps/web/src-tauri/sidecar/`
  - Set up package.json with johnny-five dependency
  - Configure TypeScript for the sidecar worker
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. Implement Node.js hardware worker
  - [x] 2.1 Create hardware worker class with state management
    - Implement HardwareWorker class with board/LED state
    - Add stdin command listener
    - Add stdout response writer
    - _Requirements: 1.1, 3.1_

  - [x] 2.2 Implement connect command handler
    - Initialize Johnny-Five Board with optional port
    - Handle board 'ready' event
    - Handle board 'error' event
    - Return success/error response
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [x] 2.3 Implement startBlink command handler
    - Create LED component on specified pin
    - Start blink with specified interval
    - Update internal state
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 2.4 Implement stopBlink command handler
    - Stop LED blinking
    - Update internal state
    - _Requirements: 2.5_

  - [x] 2.5 Implement disconnect command handler
    - Stop LED if blinking
    - Close board connection
    - Reset internal state
    - _Requirements: 3.3, 3.4_

  - [x] 2.6 Implement getStatus command handler
    - Return current connection and blink status
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 2.7 Write property test for command serialization
    - **Property 6: Command Serialization**
    - **Validates: Requirements 1.1, 2.1, 2.5, 3.3**

- [x] 3. Implement Tauri commands
  - [x] 3.1 Set up Rust sidecar process management
    - Add sidecar configuration to tauri.conf.json
    - Implement sidecar lifecycle management (start/stop/restart)
    - Add process state tracking
    - _Requirements: 3.1, 3.3_

  - [x] 3.2 Implement hardware_connect command
    - Send connect command to sidecar via stdin
    - Parse response from stdout
    - Handle timeout (5 seconds)
    - Return result to frontend
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 3.3 Implement hardware_start_blink command
    - Send startBlink command with pin and interval
    - Parse response from stdout
    - Handle errors
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 3.4 Implement hardware_stop_blink command
    - Send stopBlink command to sidecar
    - Parse response
    - _Requirements: 2.5_

  - [x] 3.5 Implement hardware_disconnect command
    - Send disconnect command to sidecar
    - Handle cleanup
    - _Requirements: 3.3, 3.4, 3.5_

  - [x] 3.6 Implement hardware_get_status command
    - Send getStatus command to sidecar
    - Parse and return status
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 3.7 Write unit tests for Tauri commands
    - Test command serialization
    - Test error handling
    - Test timeout behavior
    - _Requirements: 1.4, 1.5_

- [x] 4. Checkpoint - Verify sidecar communication
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement React UI components
  - [x] 5.1 Create platform detection utility
    - Implement isDesktop() function using @tauri-apps/plugin-os
    - Handle web vs Tauri detection
    - _Requirements: 5.1_

  - [x] 5.2 Create HardwareControl component
    - Add connection button with loading state
    - Add start/stop blink buttons
    - Add disconnect button
    - Display connection status
    - Show "Desktop only" message for web
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [x] 5.3 Implement Tauri command invocations
    - Use invoke() from @tauri-apps/api/core
    - Handle async operations with loading states
    - Display errors using toast notifications (sonner)
    - _Requirements: 1.4, 1.5, 4.4_

  - [x] 5.4 Add status polling
    - Poll hardware_get_status every 2 seconds when connected
    - Update UI based on status
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 5.5 Write unit tests for React components
    - Test platform detection
    - Test button states
    - Test error handling
    - Mock Tauri invoke calls
    - _Requirements: 4.4_

- [x] 6. Implement error handling and logging
  - [x] 6.1 Add comprehensive error handling in sidecar
    - Handle "no board found" errors
    - Handle connection timeout errors
    - Handle serial port errors
    - Handle "already connected" errors
    - _Requirements: 1.4, 1.5_

  - [x] 6.2 Add logging to sidecar worker
    - Log connection attempts
    - Log successful connections
    - Log errors with context
    - Log cleanup actions
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 6.3 Add error recovery in Tauri backend
    - Detect sidecar crashes
    - Implement sidecar restart logic
    - Notify frontend of errors
    - _Requirements: 3.3, 3.4_

  - [ ]* 6.4 Write property test for error handling
    - **Property 5: Error Handling and Logging**
    - **Validates: Requirements 1.4, 1.5, 4.4**

- [ ] 7. Implement property-based tests
  - [ ]* 7.1 Write property test for board connection
    - **Property 1: Board Connection and Ready Event**
    - **Validates: Requirements 1.1, 1.2, 1.3, 3.1**

  - [ ]* 7.2 Write property test for LED creation
    - **Property 2: LED Creation and Blink Activation**
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 7.3 Write property test for blink timing
    - **Property 3: Configurable Blink Interval**
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 7.4 Write property test for graceful shutdown
    - **Property 4: Graceful Shutdown and Cleanup**
    - **Validates: Requirements 2.5, 3.3, 3.4, 3.5**

  - [ ]* 7.5 Write property test for state consistency
    - **Property 4: State Consistency**
    - Test that sidecar state remains consistent across operations
    - **Validates: Requirements 2.1, 2.2, 2.5, 3.3**

  - [ ]* 7.6 Write property test for success logging
    - **Property 6: Success Logging**
    - **Validates: Requirements 3.2, 4.1, 4.2, 4.3**

- [ ] 8. Integration and documentation
  - [ ] 8.1 Add hardware control route to app
    - Create route in Tanstack Router
    - Add navigation link
    - _Requirements: 5.1_

  - [ ] 8.2 Update Tauri configuration
    - Configure sidecar bundling
    - Set up permissions
    - Configure build settings
    - _Requirements: 5.2, 5.3_

  - [ ] 8.3 Create README documentation
    - Document setup instructions
    - Document Arduino requirements (StandardFirmata)
    - Document usage instructions
    - Add troubleshooting section
    - _Requirements: 5.4_

  - [ ]* 8.4 Write integration tests
    - Test full flow: connect → blink → stop → disconnect
    - Test error scenarios
    - Test sidecar restart
    - _Requirements: 1.1, 2.1, 2.5, 3.3_

- [ ] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- The sidecar worker runs as a separate Node.js process
- Web app will show "Desktop only" message (no hardware access)
