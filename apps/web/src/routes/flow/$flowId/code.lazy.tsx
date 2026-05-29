import { createLazyFileRoute } from "@tanstack/react-router";
import { SketchCodeView } from "@/components/flow/sketch-code-view";
import { BoardTargetPicker } from "@/components/flow/board-target-picker";

export const Route = createLazyFileRoute("/flow/$flowId/code")({
    component: RouteComponent,
});

/**
 * Standalone Code view — the generated Arduino sketch for the current Flow,
 * shown on its own menu-bar route (mirrors the circuit view). Reads the live
 * Flow session through `SketchCodeView`; the board-target picker lives here, as
 * part of the Code view, so the Author can re-target without leaving the page.
 */
function RouteComponent() {
    return (
        <div className="flex flex-col w-full h-full p-4 gap-4">
            <div className="flex items-center justify-between shrink-0">
                <h1 className="text-lg font-medium">Generated sketch</h1>
                <BoardTargetPicker />
            </div>
            <SketchCodeView />
        </div>
    );
}
