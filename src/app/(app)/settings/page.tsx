import { redirect } from "next/navigation";

/** /settings on its own has nothing to show — the sidebar is the index. Send
 *  people to the first section rather than rendering an empty shell. */
export default function SettingsIndex() {
  redirect("/settings/account");
}
