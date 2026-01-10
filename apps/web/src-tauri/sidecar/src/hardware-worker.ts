/**
 * Hardware Worker Sidecar
 * 
 * This Node.js process runs alongside the Tauri application to provide
 * Johnny-Five hardware control capabilities. It communicates via stdin/stdout
 * using JSON messages.
 */

import { Board, Led } from 'johnny-five';

// Command types
interface SidecarCommand {
  type: 'connect' | 'startBlink' | 'stopBlink' | 'disconnect' | 'getStatus';
  port?: string;
  pin?: number;
  interval?: number;
}

// Response types
interface SidecarResponse {
  success: boolean;
  message?: string;
  data?: any;
}

/**
 * Logger utility for consistent logging to stderr
 */
class Logger {
  private static log(level: string, message: string, context?: any): void {
    const timestamp = new Date().toISOString();
    const logMessage = context 
      ? `[${timestamp}] [${level}] ${message} ${JSON.stringify(context)}`
      : `[${timestamp}] [${level}] ${message}`;
    console.error(logMessage);
  }

  static info(message: string, context?: any): void {
    this.log('INFO', message, context);
  }

  static error(message: string, context?: any): void {
    this.log('ERROR', message, context);
  }

  static warn(message: string, context?: any): void {
    this.log('WARN', message, context);
  }

  static debug(message: string, context?: any): void {
    this.log('DEBUG', message, context);
  }
}

/**
 * HardwareWorker manages the Johnny-Five board connection and LED control
 */
class HardwareWorker {
  private board: Board | null = null;
  private led: Led | null = null;
  private isConnected: boolean = false;
  private isBlinking: boolean = false;
  private currentPin: number | null = null;
  private currentInterval: number | null = null;

  constructor() {
    this.setupStdinListener();
  }

  /**
   * Set up stdin listener to receive commands from Tauri
   */
  private setupStdinListener(): void {
    process.stdin.setEncoding('utf8');
    
    let buffer = '';
    
    process.stdin.on('data', async (chunk: string) => {
      buffer += chunk;
      
      // Process complete JSON messages (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const command: SidecarCommand = JSON.parse(line);
            Logger.debug('Received command', { type: command.type });
            const response = await this.handleCommand(command);
            this.sendResponse(response);
          } catch (error) {
            Logger.error('Failed to parse command', { 
              error: error instanceof Error ? error.message : String(error),
              line 
            });
            this.sendResponse({
              success: false,
              message: `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        }
      }
    });

    process.stdin.on('end', () => {
      Logger.info('Stdin closed, cleaning up');
      this.cleanup();
    });
  }

  /**
   * Send response to Tauri via stdout
   */
  private sendResponse(response: SidecarResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  /**
   * Handle incoming command
   */
  private async handleCommand(command: SidecarCommand): Promise<SidecarResponse> {
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
      default:
        return {
          success: false,
          message: `Unknown command type: ${(command as any).type}`
        };
    }
  }

  /**
   * Connect to the Arduino board
   */
  private async connect(port?: string): Promise<SidecarResponse> {
    // Handle "already connected" error
    if (this.isConnected) {
      Logger.warn('Connection attempt while already connected');
      return {
        success: false,
        message: 'Board is already connected. Disconnect first.'
      };
    }

    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let resolved = false;

      const resolveOnce = (response: SidecarResponse) => {
        if (!resolved) {
          resolved = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          resolve(response);
        }
      };

      try {
        // Log connection attempt
        Logger.info('Connecting to board...', { port: port || 'auto-detect' });
        
        const boardOptions: any = {
          repl: false,  // Disable REPL to prevent stdout pollution
          debug: false, // Disable debug output
        };
        
        if (port) {
          boardOptions.port = port;
        }

        this.board = new Board(boardOptions);

        // Handle connection timeout error
        timeoutId = setTimeout(() => {
          if (!this.isConnected) {
            Logger.error('Connection timeout - Board may not be running StandardFirmata');
            resolveOnce({
              success: false,
              message: 'Connection timeout. Board may not be running StandardFirmata.'
            });
          }
        }, 5000);

        this.board.on('ready', () => {
          this.isConnected = true;
          // Log successful connection
          Logger.info('Board connected successfully');
          resolveOnce({
            success: true,
            message: 'Board connected successfully'
          });
        });

        // Handle serial port errors and other board errors
        this.board.on('error', (error?: Error) => {
          // Log errors with context
          Logger.error('Board connection error', { 
            error: error?.message || 'Unknown error',
            stack: error?.stack 
          });
          
          let errorMessage = 'Unable to connect to board';
          
          if (error) {
            const errorStr = error.message || String(error);
            
            // Handle "no board found" errors
            if (errorStr.includes('Cannot find connected device') || 
                errorStr.includes('No Arduinos found') ||
                errorStr.includes('no such device') ||
                errorStr.includes('ENOENT')) {
              errorMessage = 'No Arduino board found. Please check connection.';
            }
            // Handle serial port errors
            else if (errorStr.includes('Permission denied') || 
                     errorStr.includes('EACCES')) {
              errorMessage = `Unable to open serial port: Permission denied. Try running with sudo or check port permissions.`;
            }
            else if (errorStr.includes('Port is not open') || 
                     errorStr.includes('Port is opening') ||
                     errorStr.includes('already open')) {
              errorMessage = `Unable to open serial port: ${errorStr}`;
            }
            else {
              errorMessage = `Unable to connect to board: ${errorStr}`;
            }
          }
          
          resolveOnce({
            success: false,
            message: errorMessage
          });
        });

      } catch (error) {
        // Log errors with context
        Logger.error('Failed to initialize board', { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        let errorMessage = 'Failed to initialize board';
        
        if (error instanceof Error) {
          const errorStr = error.message;
          
          // Handle "no board found" errors during initialization
          if (errorStr.includes('Cannot find connected device') || 
              errorStr.includes('No Arduinos found')) {
            errorMessage = 'No Arduino board found. Please check connection.';
          }
          // Handle serial port errors during initialization
          else if (errorStr.includes('Permission denied') || 
                   errorStr.includes('EACCES')) {
            errorMessage = `Unable to open serial port: Permission denied. Try running with sudo or check port permissions.`;
          }
          else {
            errorMessage = `Failed to initialize board: ${errorStr}`;
          }
        }
        
        resolveOnce({
          success: false,
          message: errorMessage
        });
      }
    });
  }

  /**
   * Start blinking an LED on the specified pin
   */
  private async startBlink(pin?: number, interval?: number): Promise<SidecarResponse> {
    if (!this.isConnected || !this.board) {
      Logger.warn('Start blink attempted without board connection');
      return {
        success: false,
        message: 'Board is not connected. Connect first.'
      };
    }

    if (this.isBlinking) {
      Logger.warn('Start blink attempted while already blinking');
      return {
        success: false,
        message: 'LED is already blinking. Stop first.'
      };
    }

    const ledPin = pin ?? 13; // Default to pin 13
    const blinkInterval = interval ?? 500; // Default to 500ms

    try {
      Logger.info('Starting LED blink', { pin: ledPin, interval: blinkInterval });
      
      this.led = new Led(ledPin);
      this.led.blink(blinkInterval);
      
      this.isBlinking = true;
      this.currentPin = ledPin;
      this.currentInterval = blinkInterval;

      Logger.info(`LED on pin ${ledPin} is blinking`);
      
      return {
        success: true,
        message: `LED on pin ${ledPin} is blinking with interval ${blinkInterval}ms`
      };
    } catch (error) {
      Logger.error('Failed to start LED blink', { 
        pin: ledPin,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return {
        success: false,
        message: `Failed to initialize LED on pin ${ledPin}: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Stop the LED from blinking
   */
  private async stopBlink(): Promise<SidecarResponse> {
    if (!this.isConnected || !this.board) {
      Logger.warn('Stop blink attempted without board connection');
      return {
        success: false,
        message: 'Board is not connected.'
      };
    }

    if (!this.isBlinking || !this.led) {
      Logger.warn('Stop blink attempted when not blinking');
      return {
        success: false,
        message: 'LED is not blinking.'
      };
    }

    try {
      const stoppedPin = this.currentPin;
      
      Logger.info('Stopping LED blink', { pin: stoppedPin });
      
      this.led.stop();
      this.led.off();
      
      this.isBlinking = false;
      
      Logger.info(`LED on pin ${stoppedPin} stopped blinking`);
      
      return {
        success: true,
        message: `LED on pin ${stoppedPin} stopped blinking`
      };
    } catch (error) {
      Logger.error('Failed to stop LED blink', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      return {
        success: false,
        message: `Failed to stop LED: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Disconnect from the board
   */
  private async disconnect(): Promise<SidecarResponse> {
    if (!this.isConnected || !this.board) {
      Logger.warn('Disconnect attempted without board connection');
      return {
        success: false,
        message: 'Board is not connected.'
      };
    }

    return new Promise((resolve) => {
      try {
        // Log cleanup actions
        Logger.info('Disconnecting from board');
        
        // Stop LED if blinking
        if (this.isBlinking && this.led) {
          Logger.info('Stopping LED before disconnect', { pin: this.currentPin });
          this.led.stop();
          this.led.off();
        }

        // Close the serial port connection
        // Johnny-Five's Board has an io object that manages the connection
        if (this.board && (this.board as any).io) {
          Logger.info('Closing serial port connection');
          const io = (this.board as any).io;
          
          // The io object has a transport (serialport) that needs to be closed
          if (io.transport && typeof io.transport.close === 'function') {
            io.transport.close((err: Error | null) => {
              if (err) {
                Logger.error('Error closing serial port', { error: err.message });
              } else {
                Logger.info('Serial port closed successfully');
              }
              
              // Reset internal state regardless of close result
              this.board = null;
              this.led = null;
              this.isConnected = false;
              this.isBlinking = false;
              this.currentPin = null;
              this.currentInterval = null;

              Logger.info('Board disconnected successfully');

              resolve({
                success: true,
                message: 'Board disconnected successfully'
              });
            });
          } else {
            // Fallback: just reset state if we can't close the port
            Logger.warn('Could not find transport.close method, resetting state only');
            
            this.board = null;
            this.led = null;
            this.isConnected = false;
            this.isBlinking = false;
            this.currentPin = null;
            this.currentInterval = null;

            resolve({
              success: true,
              message: 'Board disconnected (state reset)'
            });
          }
        } else {
          // No io object, just reset state
          Logger.warn('No io object found, resetting state only');
          
          this.board = null;
          this.led = null;
          this.isConnected = false;
          this.isBlinking = false;
          this.currentPin = null;
          this.currentInterval = null;

          resolve({
            success: true,
            message: 'Board disconnected (state reset)'
          });
        }
      } catch (error) {
        Logger.error('Failed to disconnect board', { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        // Reset state even on error
        this.board = null;
        this.led = null;
        this.isConnected = false;
        this.isBlinking = false;
        this.currentPin = null;
        this.currentInterval = null;
        
        resolve({
          success: false,
          message: `Failed to disconnect: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    });
  }

  /**
   * Get current status of the hardware worker
   */
  private getStatus(): SidecarResponse {
    return {
      success: true,
      data: {
        connected: this.isConnected,
        blinking: this.isBlinking,
        pin: this.currentPin,
        interval: this.currentInterval
      }
    };
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    Logger.info('Cleaning up resources');
    
    if (this.isBlinking && this.led) {
      Logger.info('Stopping LED during cleanup', { pin: this.currentPin });
      try {
        this.led.stop();
        this.led.off();
      } catch (error) {
        Logger.error('Error stopping LED during cleanup', { error });
      }
    }
    
    // Reset state
    this.board = null;
    this.led = null;
    this.isConnected = false;
    this.isBlinking = false;
    
    Logger.info('Cleanup complete');
    
    // Exit the process to ensure clean shutdown
    process.exit(0);
  }
}

// Initialize and start the worker
const worker = new HardwareWorker();
Logger.info('Hardware worker initialized');

// Handle process termination signals
process.on('SIGINT', () => {
  Logger.info('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  Logger.info('Received SIGTERM, shutting down...');
  process.exit(0);
});
