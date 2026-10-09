import { WifiOff } from "lucide-react";

export function ServiceNotice({ title, description, className = "" }: {
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={`service-notice ${className}`} role="status">
      <WifiOff size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
