import { useState, useEffect } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { getSession } from "@/lib/auth-client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { COLLAB_COLORS } from "@microflow/collab/sync-provider";
import { Separator } from "@/components/ui/separator";
import { ComputerIcon, MoonIcon, SunIcon } from "lucide-react";
import { LoadingState } from "@/components/states/loading-state";
import { ErrorState } from "@/components/states/error-state";
import { EmptyState } from "@/components/states/empty-state";
import { useTheme } from "@/providers/theme-provider";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { ButtonGroup } from "@/components/ui/button-group";

const COLLAB_ICONS = [
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
] as const satisfies IconName[];

const THEMES = [
  { key: "dark", icon: MoonIcon, label: "Dark" },
  { key: "system", icon: ComputerIcon, label: "System" },
  { key: "light", icon: SunIcon, label: "Light" },
] as const;

export const Route = createFileRoute("/profile")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data?.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: ProfilePage,
});

function ProfilePage() {
  const queryClient = useQueryClient();
  const {
    data: profile,
    isLoading,
    error,
  } = useQuery(trpc.profile.get.queryOptions());
  const { theme, setTheme } = useTheme();

  // Hovering a swatch or critter previews it live in the header.
  const [hoveredColor, setHoveredColor] = useState<string | null>(null);
  const [hoveredIcon, setHoveredIcon] = useState<IconName | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [debouncedUsername] = useDebouncedValue(username, { wait: 600 });

  useEffect(() => {
    if (profile) setUsername(profile.name ?? "");
  }, [profile?.name]);

  const updateName = useMutation(
    trpc.profile.updateName.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.profile.get.queryKey() });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  useEffect(() => {
    if (
      debouncedUsername !== null &&
      debouncedUsername.trim() &&
      debouncedUsername !== profile?.name
    ) {
      updateName.mutate({ name: debouncedUsername.trim() });
    }
  }, [debouncedUsername]);

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

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState title="Failed to load profile" error={error} />;
  if (!profile)
    return (
      <EmptyState
        title="Profile not found"
        description="Please try again later"
      />
    );

  const color = hoveredColor ?? profile.settings.collabColor;
  const icon = (hoveredIcon ?? profile.settings.collabIcon) as IconName;

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
              className="size-[88px] rounded-2xl flex items-center justify-center shadow-sm transition-colors duration-500 ease-out"
              style={{ backgroundColor: color }}
            >
              <Icon icon={icon} size={40} className="text-white" />
            </div>
          </div>
          <div className="pb-1.5 min-w-0">
            <p className="text-xl font-semibold truncate">
              {username || "Unnamed"}
            </p>
            <p className="text-sm text-muted-foreground truncate">
              {profile.email}
            </p>
          </div>
        </div>

        <div className="mt-10 space-y-8">
          <div className="space-y-2">
            <Label htmlFor="username">Display name</Label>
            <Input
              id="username"
              value={username ?? ""}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your name"
            />
            <p className="text-xs text-muted-foreground">Saves as you type.</p>
          </div>

          <div className="space-y-3">
            <Label>Your colour</Label>
            <div className="flex flex-wrap gap-2">
              {COLLAB_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  style={{ backgroundColor: swatch }}
                  className={cn(
                    "size-8 rounded-full transition-transform duration-200 ease-out",
                    profile.settings.collabColor === swatch
                      ? "ring-2 ring-offset-2 ring-offset-background ring-primary scale-110"
                      : "hover:scale-125 hover:-translate-y-0.5"
                  )}
                  onClick={() => updateCollab.mutate({ collabColor: swatch })}
                  onMouseEnter={() => setHoveredColor(swatch)}
                  onMouseLeave={() => setHoveredColor(null)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <Label>Your critter</Label>
            <div className="flex flex-wrap gap-2">
              {COLLAB_ICONS.map((critter) => {
                const isSelected = profile.settings.collabIcon === critter;
                return (
                  <button
                    key={critter}
                    type="button"
                    style={
                      isSelected
                        ? { backgroundColor: color, borderColor: color }
                        : undefined
                    }
                    className={cn(
                      "size-10 rounded-xl border flex items-center justify-center transition-all duration-200 ease-out",
                      isSelected
                        ? "text-white scale-110 shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:scale-110 hover:-translate-y-0.5"
                    )}
                    onClick={() => updateCollab.mutate({ collabIcon: critter })}
                    onMouseEnter={() => setHoveredIcon(critter)}
                    onMouseLeave={() => setHoveredIcon(null)}
                  >
                    <Icon icon={critter} size={18} />
                  </button>
                );
              })}
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>Appearance</Label>
            <ButtonGroup className="w-full">
              {THEMES.map(({ key, icon: ThemeIcon, label }) => (
                <Button
                  key={key}
                  variant={theme === key ? "default" : "outline"}
                  className="grow gap-2"
                  onClick={() => setTheme(key)}
                >
                  <ThemeIcon className="size-4" /> {label}
                </Button>
              ))}
            </ButtonGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
