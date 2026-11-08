import type { Candidate } from "@/lib/types";

export type CandidateApplicationGroup = {
  key: string;
  primary: Candidate;
  applications: Candidate[];
  departments: string[];
  shifts: string[];
};

export function groupCandidateApplications(candidates: Candidate[]): CandidateApplicationGroup[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const clusters = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const source = candidate.source_candidate_id ? byId.get(candidate.source_candidate_id) : undefined;
    const rootId = source ? (source.source_candidate_id ?? source.id) : candidate.id;
    const list = clusters.get(rootId) ?? [];
    list.push(candidate);
    clusters.set(rootId, list);
  }

  return [...clusters.values()].map((applications) => {
    const sorted = [...applications].sort((a, b) =>
      Number(Boolean(a.source_candidate_id)) - Number(Boolean(b.source_candidate_id)) ||
      (a.shift ?? "").localeCompare(b.shift ?? "", "vi"),
    );
    const departments = [...new Set(sorted.map((item) => item.department).filter(Boolean) as string[])];
    const shifts = [...new Set(sorted.map((item) => item.shift).filter(Boolean) as string[])];
    return { key: sorted[0].id, primary: sorted[0], applications: sorted, departments, shifts };
  });
}

export function CandidateApplicationSummary({ group }: { group: CandidateApplicationGroup }) {
  return (
    <div className="min-w-0">
      <p className="font-medium">{group.primary.full_name}</p>
      {group.applications.length > 1 && (
        <p className="mt-1 text-xs font-medium text-violet-700 dark:text-violet-300">
          {group.departments.join(" · ")} · {group.shifts.join(" ; ")}
        </p>
      )}
    </div>
  );
}
