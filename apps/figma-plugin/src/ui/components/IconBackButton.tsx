import { Button, Icons } from "@fhb/ui";
import { useLocation, useNavigate } from "react-router-dom";

export function IconBackButton() {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === "/") return null;

  return <Button variant="ghost" size="icon" title="Back" className="mr-2" onClick={() => navigate(-1)} >
    <Icons.ArrowLeft className="w-4 h-4" />
  </Button>;
}
