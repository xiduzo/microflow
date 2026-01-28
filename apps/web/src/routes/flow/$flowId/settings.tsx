import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, trpc } from "@/lib/trpc";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { useForm } from "@tanstack/react-form";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import {
    InputGroup,
    InputGroupInput,
} from "@/components/ui/input-group";
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
import { EllipsisVerticalIcon, ShieldUserIcon, TrashIcon } from "lucide-react";
import { ShareFlowDialog } from "@/components/flow/dialogs/share-flow-dialog";
import { DeleteFlowDialog } from "@/components/flow/dialogs/delete-flow-dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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

    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState title="Failed to load flow" error={error} />;
    if (!data)
        return <ErrorState title="Flow not found" error="Flow not found" />;

    return (
        <div className="container max-w-3xl mx-auto py-8 px-4 space-y-6">
            <div>
                <h1 className="text-2xl font-semibold">Flow Settings</h1>
                <p className="text-muted-foreground text-sm">Manage your flow</p>
            </div>
            <div className="space-y-6">
                <FlowSettingsCard name={data.name} color={data.color} flowId={flowId} />
                <FlowCollaboratorsCard
                    collaborators={data.collaborators}
                    owner={data.owner}
                    flowId={flowId}
                    flowName={data.name}
                />
                <DeleteFlowCard flowId={flowId} flowName={data.name} />
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

function FlowCollaboratorsCard(props: {
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

    return (
        <Card>
            <CardHeader>
                <CardTitle>Collaborators</CardTitle>
                <CardDescription>
                    Share this flow with others to collaborate on it.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead></TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Email</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead>Actions</TableHead>
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
                                <TableCell className="flex gap-2">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger>
                                            <Button variant="outline">
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
                    </TableBody>
                    <TableCaption>
                        <ShareFlowDialog flowId={props.flowId} flowName={props.flowName} />
                    </TableCaption>
                </Table>
            </CardContent>
        </Card>
    );
}

function FlowSettingsCard(props: {
    name: string;
    color: string;
    flowId: string;
}) {
    const updateFlow = useMutation(
        trpc.flow.update.mutationOptions({
            onSuccess: () => {
                queryClient.invalidateQueries({ queryKey: trpc.flow.list.queryKey() });
                queryClient.invalidateQueries({
                    queryKey: trpc.flow.get.queryKey({ id: props.flowId }),
                });
                form.reset();
                toast.success("Flow updated");
            },
        })
    );

    const form = useForm({
        defaultValues: {
            name: props.name,
            color: props.color,
        },
        onSubmit: (values) => {
            updateFlow.mutate({
                id: props.flowId,
                ...values.value,
            });
        },
    });

    return (
        <form>
            <Card>
                <CardHeader>
                    <CardTitle>Flow Details</CardTitle>
                </CardHeader>
                <CardContent>
                    <FieldGroup>
                        <form.Field name="name">
                            {(field) => (
                                <Field>
                                    <FieldLabel htmlFor={field.name}>Purpose of this flow</FieldLabel>
                                    <InputGroup>
                                        <InputGroupInput
                                            id={field.name}
                                            name={field.name}
                                            placeholder="My awesome flow"
                                            value={field.state.value}
                                            onBlur={field.handleBlur}
                                            onChange={(e) => field.handleChange(e.target.value)}
                                            required
                                        />
                                        {/* <InputGroupAddon>
                      <Mail />
                    </InputGroupAddon> */}
                                    </InputGroup>
                                    <FieldError errors={field.state.meta.errors} />
                                </Field>
                            )}
                        </form.Field>
                        <form.Field name="color">
                            {(field) => (
                                <Field>
                                    <FieldLabel htmlFor={field.name}>Quick identifier</FieldLabel>
                                    <div className="flex flex-wrap gap-2">
                                        {FLOW_COLORS.map((color) => (
                                            <button
                                                key={color}
                                                type="button"
                                                className={cn(
                                                    "w-8 h-8 rounded-full transition-all",
                                                    field.state.value === color
                                                        ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                                                        : "hover:scale-105 hover:ring-1 hover:ring-offset-2 hover:ring-offset-background/5 hover:ring-primary/5"
                                                )}
                                                style={{ backgroundColor: color }}
                                                onClick={() => field.handleChange(color)}
                                            />
                                        ))}
                                    </div>
                                </Field>
                            )}
                        </form.Field>
                    </FieldGroup>
                </CardContent>
                <CardFooter className="justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => form.reset()}>
                        Reset
                    </Button>
                    <Button
                        onClick={() => form.handleSubmit()}
                        disabled={!form.state.isValid || updateFlow.isPending}
                    >
                        Save
                    </Button>
                </CardFooter>
            </Card>
        </form>
    );
}

function DeleteFlowCard(props: { flowId: string; flowName: string }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-destructive">Danger Zone</CardTitle>
                <CardDescription>
                    Deleting this flow will remove it for all collaborators.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-end">
                <DeleteFlowDialog flow={{ id: props.flowId, name: props.flowName }} trigger={<Button variant="destructive">Delete Flow</Button>} />
            </CardContent>
        </Card>
    );
}

export const FLOW_COLORS = [
    "#fca5a5", // red-300
    "#fdba74", // orange-300
    "#fcd34d", // amber-300
    "#fde047", // yellow-300
    "#bef264", // lime-300
    "#86efac", // green-300
    "#6ee7b7", // emerald-300
    "#5eead4", // teal-300
    "#67e8f9", // cyan-300
    "#7dd3fc", // sky-300
    "#93c5fd", // blue-300
    "#a5b4fc", // indigo-300
    "#c4b5fd", // violet-300
    "#d8b4fe", // purple-300
    "#f0abfc", // fuchsia-300
    "#f9a8d4", // pink-300
    "#fda4af", // rose-300
] as const;
