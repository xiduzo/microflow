import { useEffect } from "react";
import { toast } from "sonner";
import { useBoardState } from "@/stores/board";
import { useAppStore } from "@/stores/app";

export function useFirstArduinoConnection() {
  const boardState = useBoardState();
  const hasConnectedArduino = useAppStore((s) => s.hasConnectedArduino);
  const showConfetti = useAppStore((s) => s.showConfetti);
  const markArduinoConnected = useAppStore((s) => s.markArduinoConnected);
  const dismissConfetti = useAppStore((s) => s.dismissConfetti);

  useEffect(() => {
    if (boardState !== "connected") return;
    if (hasConnectedArduino) return;

    markArduinoConnected();
    toast.success("Arduino connected! 🎉", {
      description: "Your first board is ready to go. Happy prototyping!",
    });

    const timer = setTimeout(dismissConfetti, 6000);
    return () => clearTimeout(timer);
  }, [boardState, hasConnectedArduino, markArduinoConnected, dismissConfetti]);

  return showConfetti;
}
