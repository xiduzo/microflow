import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, trpc } from "@/lib/trpc";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
    Table,
    TableHead,
    TableRow,
    TableHeader,
    TableCell,
    TableBody,
    TableCaption,
} from "@/components/ui/table";
import {
    EllipsisVerticalIcon,
    MailIcon,
    ShieldUserIcon,
    TrashIcon,
} from "lucide-react";
import { ShareFlowDialog } from "@/components/flow/dialogs/share-flow-dialog";
import { DeleteFlowDialog } from "@/components/flow/dialogs/delete-flow-dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FLOW_COLORS } from "@/lib/flow-colors";
import { useDebouncedValue } from "@tanstack/react-pacer";

export const Route = createFileRoute("/flow/$flowId/settings")({
    component: RouteComponent,
    beforeLoad: async ({ params }) => {
        if (params.flowId === "local") {
            return redirect({
                to: "/",
            });
        }
        return params;
    },
});

function RouteComponent() {
    const { flowId } = Route.useParams();

    const { data, isLoading, error } = useQuery({
        ...trpc.flow.get.queryOptions({ id: flowId }),
        enabled: flowId !== "local",
    });

    // Hovering a swatch previews it live in the banner and tile.
    const [hoveredColor, setHoveredColor] = useState<string | null>(null);
    const [name, setName] = useState<string | null>(null);
    const [debouncedName] = useDebouncedValue(name, { wait: 600 });

    useEffect(() => {
        if (data) setName(data.name);
    }, [data?.name]);

    const updateFlow = useMutation(
        trpc.flow.update.mutationOptions({
            onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
                queryClient.invalidateQueries({
                    queryKey: trpc.flow.get.queryKey({ id: flowId }),
                });
            },
            onError: (error) => {
                toast.error(error.message);
            },
        })
    );

    useEffect(() => {
        if (debouncedName !== null && debouncedName.trim() && debouncedName !== data?.name) {
            updateFlow.mutate({ id: flowId, name: debouncedName.trim() });
        }
    }, [debouncedName]);

    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState title="Failed to load flow" error={error} />;
    if (!data)
        return <ErrorState title="Flow not found" error="Flow not found" />;

    const color = hoveredColor ?? data.color;

    return (
        <div className="h-full overflow-auto">
            {/* Banner takes its tint from the live colour choice. The colour lives on
                background-color (which transitions) while the fade is a mask, since
                background-image gradients don't animate. */}
            <div
                className="h-40 w-full transition-colors duration-500 ease-out"
                style={{
                    backgroundColor: color,
                    maskImage: "linear-gradient(160deg, rgba(0,0,0,0.55), transparent 85%)",
                    WebkitMaskImage:
                        "linear-gradient(160deg, rgba(0,0,0,0.55), transparent 85%)",
                }}
            />

            <div className="container max-w-2xl mx-auto px-4 pb-16">
                <div className="-mt-12 flex items-end gap-4">
                    <div className="rounded-3xl p-1.5 -ml-1.5 bg-background">
                        <div
                            className="size-[88px] rounded-2xl shadow-sm transition-colors duration-500 ease-out"
                            style={{ backgroundColor: color }}
                        />
                    </div>
                    <div className="pb-1.5 min-w-0">
                        <p className="text-xl font-semibold truncate">
                            {name || "Untitled flow"}
                        </p>
                        <p className="text-sm text-muted-foreground truncate">
                            {data.collaborators.length + 1}{" "}
                            {data.collaborators.length === 0 ? "collaborator" : "collaborators"}
                        </p>
                    </div>
                </div>

                <div className="mt-10 space-y-8">
                    <div className="space-y-2">
                        <Label htmlFor="flow-name">Purpose of this flow</Label>
                        <Input
                            id="flow-name"
                            value={name ?? ""}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="My awesome flow"
                        />
                        <p className="text-xs text-muted-foreground">Saves as you type.</p>
                    </div>

                    <div className="space-y-3">
                        <Label>Quick identifier</Label>
                        <div className="flex flex-wrap gap-2">
                            {FLOW_COLORS.map((swatch) => (
                                <button
                                    key={swatch}
                                    type="button"
                                    style={{ backgroundColor: swatch }}
                                    className={cn(
                                        "size-8 rounded-full transition-transform duration-200 ease-out",
                                        data.color === swatch
                                            ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                                            : "hover:scale-125 hover:-translate-y-0.5"
                                    )}
                                    onClick={() => updateFlow.mutate({ id: flowId, color: swatch })}
                                    onMouseEnter={() => setHoveredColor(swatch)}
                                    onMouseLeave={() => setHoveredColor(null)}
                                />
                            ))}
                        </div>
                    </div>

                    <Separator />

                    <FlowCollaborators
                        collaborators={data.collaborators}
                        owner={data.owner}
                        flowId={flowId}
                        flowName={data.name}
                    />

                    <Separator />

                    <div className="space-y-3">
                        <div>
                            <Label className="text-destructive">Danger zone</Label>
                            <p className="text-xs text-muted-foreground mt-1">
                                Deleting this flow will remove it for all collaborators.
                            </p>
                        </div>
                        <DeleteFlowDialog
                            flow={{ id: flowId, name: data.name }}
                            trigger={
                                <Button variant="destructive">
                                    <TrashIcon /> Delete flow
                                </Button>
                            }
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

type User = {
    id: string;
    name: string;
    email: string;
    collabColor?: string;
    collabIcon?: string;
    role?: string;
};

type Collaborator = {
    role: string;
    user: User;
};

function FlowCollaborators(props: {
    owner: User;
    collaborators: Collaborator[];
    flowId: string;
    flowName: string;
}) {

    const removeCollaboratorMutation = useMutation(trpc.flow.removeCollaborator.mutationOptions({
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: trpc.flow.get.queryKey({ id: props.flowId }),
            });
            toast.success("Collaborator removed");
        },
    }))

    const updateCollaboratorRoleMutation = useMutation(trpc.flow.updateCollaboratorRole.mutationOptions({
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: trpc.flow.get.queryKey({ id: props.flowId }),
            });
            toast.success("Collaborator role updated");
        },
    }))

    // Invites for addresses with no account yet — they become collaborators
    // on sign-up, and are invisible until then without this.
    const { data: pendingInvites = [] } = useQuery(
        trpc.flow.pendingInvites.queryOptions({ flowId: props.flowId }),
    );

    const revokeInviteMutation = useMutation(trpc.flow.revokeInvite.mutationOptions({
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: trpc.flow.pendingInvites.queryKey({ flowId: props.flowId }),
            });
            toast.success("Invite withdrawn");
        },
    }))

    return (
        <div className="space-y-3">
            <div>
                <Label>Collaborators</Label>
                <p className="text-xs text-muted-foreground mt-1">
                    Share this flow with others to collaborate on it.
                </p>
            </div>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead></TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead></TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    <TableRow>
                        <TableCell>
                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: props.owner.collabColor ?? "#4338ca" }}>
                                <Icon icon={props.owner.collabIcon as IconName} />
                            </div>
                        </TableCell>
                        <TableCell>{props.owner.name}</TableCell>
                        <TableCell>{props.owner.email}</TableCell>
                        <TableCell>owner</TableCell>
                        <TableCell></TableCell>
                    </TableRow>
                    {props.collaborators.map((collaborator) => (
                        <TableRow key={collaborator.user.id}>
                            <TableCell>
                                <div className="w-5 h-5 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: collaborator.user.collabColor ?? "#4338ca" }}>
                                    <Icon icon={collaborator.user.collabIcon as IconName} />
                                </div>
                            </TableCell>
                            <TableCell>{collaborator.user.name}</TableCell>
                            <TableCell>{collaborator.user.email}</TableCell>
                            <TableCell>{collaborator.role}</TableCell>
                            <TableCell className="flex gap-2 justify-end">
                                <DropdownMenu>
                                    <DropdownMenuTrigger>
                                        <Button variant="ghost" size="icon">
                                            <EllipsisVerticalIcon />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                        <DropdownMenuSub>
                                            <DropdownMenuSubTrigger>
                                                <ShieldUserIcon />
                                                User role
                                            </DropdownMenuSubTrigger>
                                            <DropdownMenuSubContent>
                                                <DropdownMenuRadioGroup
                                                    value={collaborator.role}
                                                    onValueChange={value => updateCollaboratorRoleMutation.mutate({ flowId: props.flowId, userId: collaborator.user.id, role: value as "viewer" | "editor" })}
                                                >
                                                    <DropdownMenuRadioItem value="viewer">
                                                        Viewer
                                                    </DropdownMenuRadioItem>
                                                    <DropdownMenuRadioItem value="editor">
                                                        Editor
                                                    </DropdownMenuRadioItem>
                                                </DropdownMenuRadioGroup>
                                            </DropdownMenuSubContent>
                                        </DropdownMenuSub>
                                        <DropdownMenuItem variant="destructive" onClick={() => removeCollaboratorMutation.mutate({ flowId: props.flowId, userId: collaborator.user.id })}>
                                            <TrashIcon /> remove
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </TableCell>
                        </TableRow>
                    ))}
                    {pendingInvites.map((invite) => (
                        <TableRow key={invite.id} className="text-muted-foreground">
                            <TableCell>
                                <div className="w-5 h-5 rounded-full border border-dashed flex items-center justify-center">
                                    <MailIcon className="size-3" />
                                </div>
                            </TableCell>
                            <TableCell className="italic">Invited</TableCell>
                            <TableCell>{invite.email}</TableCell>
                            <TableCell>{invite.role}</TableCell>
                            <TableCell className="flex gap-2 justify-end">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => revokeInviteMutation.mutate({ flowId: props.flowId, email: invite.email })}
                                >
                                    <TrashIcon />
                                </Button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
                <TableCaption>
                    <ShareFlowDialog flowId={props.flowId} flowName={props.flowName} />
                </TableCaption>
            </Table>
        </div>
    );
}
