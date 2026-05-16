import {
  BadgeCheck,
  Bell,
  ChevronsUpDown,
  CreditCard,
  GemIcon,
  Heart,
  LogIn,
  LogOut,
  PickaxeIcon,
  Sparkles,
  User,
  User2Icon,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";
import { useAppStore } from "@/stores/app";
import { isDesktop } from "@/lib/platform";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Icon, type IconName } from "@/components/ui/icon";

type User = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
} | null;

type Props = {
  user: User;
};

export function NavUser({ user }: Props) {
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveFlowId = useAppStore((s) => s.setActiveFlowId);

  // Fetch user profile settings if signed in
  const { data: profile } = useQuery({
    ...trpc.profile.get.queryOptions(),
    enabled: !!user,
  });

  const { data: supporterStatus } = useQuery({
    ...trpc.supporters.myStatus.queryOptions(),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
  const isSupporter = supporterStatus?.isSupporter ?? false;

  if (!user) {
    return (
      <SidebarMenu className="w-full">
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="w-full"
            render={(props) => <Link to="/login" {...props} />}
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-yellow-700 text-yellow-100">
              <User2Icon />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">Sign in</span>
              <span className="truncate text-xs text-muted-foreground">
                Or create a new account
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const collabColor = profile?.settings.collabColor ?? "#4338ca";
  const collabIcon = (profile?.settings.collabIcon ?? "Cat") as IconName;

  return (
    <SidebarMenu className="w-full">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="w-full"
            render={
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent w-full data-[state=open]:text-sidebar-accent-foreground"
              />
            }
          >
            <div
              className="aspect-square size-8 rounded-lg bg-card-foreground flex items-center justify-center"
              style={{
                backgroundColor: collabColor ?? "var(--foreground)",
              }}
            >
              <Icon icon={collabIcon} size={16} className="text-white" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{profile?.name ?? user.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {user.email}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto" />
          </DropdownMenuTrigger>

          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <div
                    className="h-8 w-8 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: collabColor }}
                  >
                    <Icon icon={collabIcon} size={16} className="text-white" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium inline-flex items-center gap-1">
                    {profile?.name ?? user.name}
                    {isSupporter ? (
                      <Heart
                        className="size-3 text-rose-500 fill-rose-500"
                        aria-label="Supporter"
                      />
                    ) : null}
                  </span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            {/* <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                <GemIcon />
                Upgrade to Pro
              </DropdownMenuItem>
            </DropdownMenuGroup> */}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => navigate({ to: "/profile" })}>
                <User />
                Profile
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                await authClient.signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      if (isDesktop()) {
                        localStorage.removeItem("bearer_token");
                      }
                      queryClient.removeQueries({ queryKey: trpc.flow.list.queryOptions().queryKey });
                      setActiveFlowId("local");
                      navigate({ to: "/" });
                    },
                    onError: (error) => {
                      toast.error(error.error.message || "Failed to sign out");
                    },
                  },
                });
              }}
            >
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
