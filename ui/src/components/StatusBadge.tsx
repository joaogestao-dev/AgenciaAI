import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

const translatedStatuses: Record<string, string> = {
  succeeded: "sucesso",
  failed: "falha",
  error: "erro",
  running: "rodando",
  queued: "na fila",
  timed_out: "esgotado",
  cancelled: "cancelado",
  idle: "ocioso",
  done: "concluído",
  in_progress: "em progresso"
};

export function StatusBadge({ status }: { status: string }) {
  const displayStatus = translatedStatuses[status] ?? status.replace("_", " ");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {displayStatus}
    </span>
  );
}
