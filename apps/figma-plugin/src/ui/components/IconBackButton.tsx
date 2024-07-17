import { Icons } from "@fhb/ui";
import { useLocation, useNavigate } from "react-router-dom";

export function IconBackButton() {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === "/") return null;

  return <Icons.ArrowLeft onClick={() => navigate(-1)} />;
}
