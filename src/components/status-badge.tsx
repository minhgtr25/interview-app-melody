import { Badge } from "@/components/ui/badge";
import { STATUS_CLASS, STATUS_LABEL, type CandidateStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: CandidateStatus; className?: string }) {
  return <Badge className={cn("border-0", STATUS_CLASS[status], className)}>{STATUS_LABEL[status]}</Badge>;
}
