import { PageTransition } from "@/components/ui/page-transition";

export default function WorkspaceTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PageTransition>{children}</PageTransition>;
}
