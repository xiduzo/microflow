import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/utils/trpc";
import { authClient } from "@/lib/auth-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { COLLAB_COLORS } from "@microflow/collab/sync-provider";
import { Separator } from "@/components/ui/separator";

const COLLAB_ICONS: IconName[] = [
  "Bird",
  "Bug",
  "Cat",
  "Dog",
  "Fish",
  "Panda",
  "Shrimp",
  "Rabbit",
  "Rat",
  "Snail",
  "Squirrel",
  "Turtle",
  "Worm",
];

export const Route = createFileRoute("/profile")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data?.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: ProfilePage,
});

function ProfilePage() {
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useQuery(
    trpc.profile.get.queryOptions()
  );

  const [hoveredColor, setHoveredColor] = useState<string | null>(null);
  const [hoveredIcon, setHoveredIcon] = useState<IconName | null>(null);

  const updateCollab = useMutation(
    trpc.profile.updateCollab.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.profile.get.queryKey(),
        });
        toast.success("Settings saved");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  if (isLoading || !profile) {
    return (
      <div className="container max-w-2xl mx-auto py-8 px-4">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-1/3" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="text-muted-foreground text-sm">
          Manage your account settings
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Collaboration</CardTitle>
          <CardDescription>
            Customize how you appear to others when collaborating on flows
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <Label>My vibe is</Label>
            <div className="flex flex-wrap gap-2">
              {COLLAB_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={cn(
                    "w-8 h-8 rounded-full transition-all",
                    profile.settings.collabColor === color
                      ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                      : "hover:scale-105"
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => updateCollab.mutate({ collabColor: color })}
                  onMouseEnter={() => setHoveredColor(color)}
                  onMouseLeave={() => setHoveredColor(null)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Label>I am team</Label>
            <div className="flex flex-wrap gap-2">
              {COLLAB_ICONS.map((icon) => {
                const isSelected = profile.settings.collabIcon === icon;
                return (
                  <Button
                    key={icon}
                    type="button"
                    variant={isSelected ? "default" : "outline"}
                    size="icon"
                    className="w-10 h-10 group"
                    onClick={() =>
                      updateCollab.mutate({ collabIcon: icon as any })
                    }
                    onMouseEnter={() => setHoveredIcon(icon)}
                    onMouseLeave={() => setHoveredIcon(null)}
                  >
                    <Icon
                      icon={icon}
                      className={cn(
                        "transition-transform duration-200",
                        isSelected ? "scale-110" : "group-hover:scale-105"
                      )}
                    />
                  </Button>
                );
              })}
            </div>
          </div>
          <Separator />
          <div>
            <Label className="text-muted-foreground">Preview</Label>
            <div className="mt-3 flex items-center gap-6">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
                  style={{
                    backgroundColor:
                      hoveredColor ?? profile.settings.collabColor,
                  }}
                >
                  <Icon
                    icon={
                      (hoveredIcon ?? profile.settings.collabIcon) as IconName
                    }
                    size={20}
                    className="text-white"
                  />
                </div>
                <div>
                  <p className="font-medium">{profile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {profile.email}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
