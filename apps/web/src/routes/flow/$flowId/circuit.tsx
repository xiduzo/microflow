import { useCircuitStore } from "@/stores/circuit-store";
import { useShallow } from "zustand/shallow";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { SchematicViewer } from "@tscircuit/schematic-viewer";
import { authClient } from "@/lib/auth-client";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { BinaryIcon, EqualApproximatelyIcon, Loader2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { cva } from "class-variance-authority";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/states/empty-state";

/** Schematic color overrides using theme CSS vars */
const SCHEMATIC_COLOR_OVERRIDES = {
    // aux_items: "var(--foreground)",
    background: "transparent",
    // brightened: "var(--accent)",
    // bus: "var(--foreground)",
    // bus_junction: "var(--foreground)",
    component_body: "var(--card)",
    component_outline: "var(--card-foreground)",
    // cursor: "var(--primary)",
    // erc_error: "var(--destructive)",
    // erc_warning: "var(--chart-2)",
    // fields: "var(--foreground)",
    // grid: "var(--muted-foreground)",
    // grid_axes: "var(--muted-foreground)",
    // hidden: "var(--muted-foreground)",
    // junction: "var(--foreground)",
    label_global: "var(--muted-foreground)",
    label_background: "var(--muted)",
    // label_hier: "var(--foreground)",
    label_local: "var(--foreground)",
    // net_name: "var(--foreground)",
    // no_connect: "var(--foreground)",
    // note: "var(--muted-foreground)",
    // pin: "var(--foreground)",
    pin_name: "var(--foreground)", // Show pin names (labels like GND, VCC, SIG)
    pin_number: "var(--card-foreground)", // Pin numbers
    // reference: "var(--foreground)",
    // shadow: "var(--foreground)",
    // sheet: "var(--background)",
    // sheet_background: "var(--background)",
    // sheet_fields: "var(--foreground)",
    // sheet_filename: "var(--foreground)",
    // sheet_label: "var(--foreground)",
    // sheet_name: "var(--foreground)",
    // table: "var(--foreground)",
    // value: "var(--foreground)",
    // wire: "var(--foreground)",
    // wire_crossing: "var(--foreground)",
    // worksheet: "var(--background)",
} as const;


export const Route = createFileRoute("/flow/$flowId/circuit")({
    component: RouteComponent,
    beforeLoad: async ({ params }) => {
        const session = await authClient.getSession();

        if (params.flowId === "local") {
            return { session };
        }

        if (!session.data) {
            throw redirect({
                to: "/login",
                search: { redirect: `/${params.flowId}/circuit` },
            });
        }

        return { session };
    },
});

function RouteComponent() {
    const { data: circuitJson, isPending, error } = useCircuitStore(
        useShallow((state) => ({ data: state.data, isPending: state.isPending, error: state.error })),
    );

    const showLoading = !circuitJson.length && isPending;

    if (error) return <ErrorState title="Failed to render circuit" error={error} />;

    return (
        <div className="w-full h-full relative">
            <div className={pendingIndicator({ isPending })}>
                <Loader2Icon className="animate-spin size-3" />
                Updating...
            </div>
            {showLoading && (
                <LoadingState title="Rendering circuit..." />
            )}
            {!circuitJson.length && (
                <EmptyState description="Your flow is empty or does not contain any components that can be rendered in a circuit." />
            )}
            {!!circuitJson.length && (
                <SchematicViewer
                    circuitJson={circuitJson}
                    editingEnabled={false}
                    // onSchematicComponentClicked={console.log}
                    // debugGrid
                    colorOverrides={{
                        schematic: SCHEMATIC_COLOR_OVERRIDES, // NOTE: Some styles are overwritten in index.css
                    }}
                    containerStyle={{
                        width: "100%",
                        height: "100%",
                        borderRadius: "2rem",
                    }}
                />
            )}
            <Card className="absolute bottom-4 w-3xs left-4 rounded-xl z-10 bg-background/50 backdrop-blur-sm border-none ring-0">
                <CardContent>
                    <Item>
                        <ItemContent>
                            <ItemTitle className="text-red-500 font-extrabold flex items-center justify-between w-full">
                                VCC
                                <PlusIcon size={12} className="text-muted-foreground opacity-50" />
                            </ItemTitle>
                            <ItemDescription>
                                Power supply voltage
                            </ItemDescription>
                        </ItemContent>
                    </Item>
                    <Item>
                        <ItemContent>
                            <ItemTitle className="text-gray-500 font-extrabold flex items-center justify-between w-full">
                                GND
                                <MinusIcon size={12} className="text-muted-foreground opacity-50" />
                            </ItemTitle>
                            <ItemDescription>
                                Ground connection
                            </ItemDescription>
                        </ItemContent>
                    </Item>
                    <Item>
                        <ItemContent>
                            <ItemTitle className="text-blue-500 font-extrabold flex items-center justify-between w-full">
                                DIN / DOUT
                                <BinaryIcon size={12} className="text-muted-foreground opacity-50" />
                            </ItemTitle>
                            <ItemDescription>
                                Digital input/output
                            </ItemDescription>
                        </ItemContent>
                    </Item>
                    <Item>
                        <ItemContent>
                            <ItemTitle className="text-yellow-500 font-extrabold flex items-center justify-between w-full">
                                SIG
                                <EqualApproximatelyIcon size={12} className="text-muted-foreground opacity-50" />
                            </ItemTitle>
                            <ItemDescription>
                                Analog signal
                            </ItemDescription>
                        </ItemContent>
                    </Item>
                </CardContent>
            </Card>
        </div>
    );
}

const pendingIndicator = cva("absolute top-4 left-4 z-10 flex items-center gap-2 text-xs text-muted-foreground transition-all", {
    variants: {
        isPending: {
            true: "opacity-100",
            false: "opacity-0",
        },
    },
    defaultVariants: {
        isPending: false,
    },
});