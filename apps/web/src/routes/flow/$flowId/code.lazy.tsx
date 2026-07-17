import { createLazyFileRoute } from "@tanstack/react-router";
import { SketchCodeView } from "@/components/flow/sketch-code-view";

export const Route = createLazyFileRoute("/flow/$flowId/code")({
    component: RouteComponent,
});

/**
 * Standalone Code view — the generated Arduino sketch for the current Flow,
 * shown on its own menu-bar route (mirrors the circuit view). The header (title
 * + generation status icon), board-target picker, and Download control live
 * inside `SketchCodeView`, which owns the generation state they reflect.
 */
function RouteComponent() {
    return (
        <div className="flex w-full h-full p-4">
            <SketchCodeView />
        </div>
    );
}
