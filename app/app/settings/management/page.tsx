import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ManagementSettingsClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ManagementSettingsPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  const support = user.support?.status === "active" ? user.support : null;
  if (!support && !(user.is_platform_admin && !user.support)
      && ROLE_RANK[org.role] < ROLE_RANK.admin) redirect("/403");
  return <ManagementSettingsClient organizationName={org.name}
    readOnly={support?.access_mode === "support_readonly"} />;
}
