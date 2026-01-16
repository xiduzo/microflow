import { Button } from "@/components/ui/button";
import { UserIcon } from "lucide-react";

export function UserPanel() {
  console.log("UserPanel");
  return (
    <div>
      <Button variant="ghost" size="icon">
        <UserIcon size={32} className="text-foreground" />
      </Button>
    </div>
  );
}
