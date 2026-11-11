import { redirect } from "next/navigation";

/** Keep legacy Signals URLs pointing to Home. */
export default function SignalsPage() {
  redirect("/");
}
