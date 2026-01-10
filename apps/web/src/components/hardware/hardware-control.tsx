import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Power, PowerOff, Zap, ZapOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isDesktop } from "@/utils/platform";

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

export function HardwareControl() {
  const [status, setStatus] = useState<HardwareStatus>({
    connected: false,
    blinking: false,
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  const desktop = isDesktop();

  // Listen for sidecar crash and restart events
  useEffect(() => {
    if (!desktop) {
      return;
    }

    let unlistenCrashed: (() => void) | undefined;
    let unlistenRestarted: (() => void) | undefined;

    const setupListeners = async () => {
      // Listen for sidecar crashes
      unlistenCrashed = await listen("sidecar-crashed", () => {
        toast.error("Hardware service crashed. Attempting to restart...", {
          duration: 5000,
        });
        // Reset connection state
        setStatus({ connected: false, blinking: false });
      });

      // Listen for successful restarts
      unlistenRestarted = await listen("sidecar-restarted", () => {
        toast.success("Hardware service restarted successfully", {
          duration: 3000,
        });
      });
    };

    setupListeners();

    // Cleanup listeners on unmount
    return () => {
      if (unlistenCrashed) unlistenCrashed();
      if (unlistenRestarted) unlistenRestarted();
    };
  }, [desktop]);

  // Poll hardware status every 2 seconds when connected
  useEffect(() => {
    if (!desktop || !status.connected) {
      return;
    }

    const pollStatus = async () => {
      try {
        const currentStatus = await invoke<HardwareStatus>("hardware_get_status");
        setStatus(currentStatus);
      } catch (error) {
        // Silently fail - don't show toast for polling errors
        console.error("Failed to poll hardware status:", error);
      }
    };

    // Poll immediately
    pollStatus();

    // Set up interval for polling
    const intervalId = setInterval(pollStatus, 2000);

    // Cleanup interval on unmount or when connection status changes
    return () => clearInterval(intervalId);
  }, [desktop, status.connected]);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const result = await invoke<HardwareResponse>("hardware_connect", {
        port: null,
      });

      if (result.success) {
        setStatus((prev) => ({ ...prev, connected: true }));
        toast.success("Board connected successfully");
      } else {
        toast.error(result.message || "Failed to connect to board");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(`Connection failed: ${errorMessage}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleStartBlink = async () => {
    setIsStarting(true);
    try {
      const result = await invoke<HardwareResponse>("hardware_start_blink", {
        pin: 13,
        interval: 500,
      });

      if (result.success) {
        setStatus((prev) => ({ ...prev, blinking: true, pin: 13, interval: 500 }));
        toast.success("LED blinking started");
      } else {
        toast.error(result.message || "Failed to start blinking");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(`Failed to start blink: ${errorMessage}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopBlink = async () => {
    setIsStopping(true);
    try {
      const result = await invoke<HardwareResponse>("hardware_stop_blink");

      if (result.success) {
        setStatus((prev) => ({ ...prev, blinking: false }));
        toast.success("LED blinking stopped");
      } else {
        toast.error(result.message || "Failed to stop blinking");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(`Failed to stop blink: ${errorMessage}`);
    } finally {
      setIsStopping(false);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const result = await invoke<HardwareResponse>("hardware_disconnect");

      if (result.success) {
        setStatus({ connected: false, blinking: false });
        toast.success("Board disconnected");
      } else {
        toast.error(result.message || "Failed to disconnect");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(`Failed to disconnect: ${errorMessage}`);
    } finally {
      setIsDisconnecting(false);
    }
  };

  if (!desktop) {
    return (
      <Card className="max-w-2xl mx-auto mt-8">
        <CardHeader>
          <CardTitle>Hardware Control</CardTitle>
          <CardDescription>Control Arduino microcontroller via Johnny-Five</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-8 text-muted-foreground">
            <div className="text-center">
              <Power className="size-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm font-medium">Desktop Only</p>
              <p className="text-xs mt-2">
                Hardware control requires the Tauri desktop application.
                <br />
                Please download and run the desktop version to access this feature.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl mx-auto mt-8">
      <CardHeader>
        <CardTitle>Hardware Control</CardTitle>
        <CardDescription>Control Arduino microcontroller via Johnny-Five</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Connection Status */}
          <div className="flex items-center justify-between p-4 bg-muted/50 rounded-none">
            <div className="flex items-center gap-3">
              <div
                className={`size-3 rounded-full ${
                  status.connected ? "bg-green-500" : "bg-gray-400"
                }`}
              />
              <div>
                <p className="text-sm font-medium">
                  {status.connected ? "Connected" : "Disconnected"}
                </p>
                {status.connected && status.blinking && (
                  <p className="text-xs text-muted-foreground">
                    LED blinking on pin {status.pin || 13} (interval: {status.interval || 500}ms)
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Control Buttons */}
          <div className="space-y-3">
            {!status.connected ? (
              <Button
                onClick={handleConnect}
                disabled={isConnecting}
                className="w-full"
                size="lg"
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Power />
                    Connect to Board
                  </>
                )}
              </Button>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {!status.blinking ? (
                    <Button
                      onClick={handleStartBlink}
                      disabled={isStarting}
                      variant="default"
                      size="lg"
                    >
                      {isStarting ? (
                        <>
                          <Loader2 className="animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <Zap />
                          Start Blink
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      onClick={handleStopBlink}
                      disabled={isStopping}
                      variant="secondary"
                      size="lg"
                    >
                      {isStopping ? (
                        <>
                          <Loader2 className="animate-spin" />
                          Stopping...
                        </>
                      ) : (
                        <>
                          <ZapOff />
                          Stop Blink
                        </>
                      )}
                    </Button>
                  )}

                  <Button
                    onClick={handleDisconnect}
                    disabled={isDisconnecting}
                    variant="destructive"
                    size="lg"
                  >
                    {isDisconnecting ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Disconnecting...
                      </>
                    ) : (
                      <>
                        <PowerOff />
                        Disconnect
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Instructions */}
          <div className="text-xs text-muted-foreground space-y-1 p-4 bg-muted/30 rounded-none">
            <p className="font-medium">Instructions:</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>Connect your Arduino board via USB</li>
              <li>Ensure StandardFirmata is uploaded to the board</li>
              <li>Click "Connect to Board" to establish connection</li>
              <li>Use "Start Blink" to blink the LED on pin 13</li>
            </ol>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
