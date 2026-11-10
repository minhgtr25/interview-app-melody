export type UserRole = "ADMIN" | "SUPPORT_IT" | "CHECKIN" | "COORDINATOR" | "INTERVIEWER";

export type CandidateStatus =
  | "NOT_ARRIVED"
  | "CHECKED_IN"
  | "ASSIGNED"
  | "INTERVIEWING"
  | "COMPLETED"
  | "ABSENT";

export type TableStatus = "AVAILABLE" | "ASSIGNED" | "INTERVIEWING";

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  table_id: string | null;
  created_at: string;
}

export interface Room {
  id: string;
  name: string;
  building_code: import("@/lib/rooms").BuildingCode | null;
  room_number: import("@/lib/rooms").RoomNumber | null;
  is_configured: boolean;
  is_challenge: boolean;
  external_challenge: boolean;
  sort_order: number;
}

export interface InterviewTable {
  id: string;
  room_id: string;
  name: string;
  department: import("@/lib/departments").DepartmentCode | null;
  specialization: import("@/lib/specializations").SpecializationCode | null;
  sort_order: number;
  status: TableStatus;
  is_paused: boolean;
  current_candidate_id: string | null;
  assigned_at: string | null;
  started_at: string | null;
  last_alarm_at: string | null;
}

export interface OpsMessage {
  id: string;
  table_id: string;
  candidate_id: string | null;
  sender_id: string | null;
  sender_label: string | null;
  kind: "CHAT" | "ALARM";
  body: string;
  created_at: string;
}

export interface DisplayCall {
  id: string;
  candidate_id: string;
  table_id: string | null;
  department: import("@/lib/departments").DepartmentCode;
  display_name: string;
  display_code: string;
  room_label: string;
  called_at: string;
}

export interface DisplaySettings {
  id: string;
  identity_mode: "NAME" | "CODE";
}

export interface Candidate {
  id: string;
  code: string;
  full_name: string;
  student_number: string | null;
  student_number_raw: string | null;
  student_cohort: string | null;
  gender: import("@/lib/personal-info").GenderCode | null;
  facebook_url: string | null;
  phone: string | null;
  email: string | null;
  department: string | null;
  specialization: import("@/lib/specializations").SpecializationCode | null;
  shift: string | null;
  source_candidate_id: string | null;
  cv_url: string | null;
  status: CandidateStatus;
  checked_in_at: string | null;
  table_id: string | null;
  challenge_table_id: string | null;
  challenge_status: "WAITING" | "ASSIGNED" | "INTERVIEWING" | "COMPLETED" | null;
  challenge_started_at: string | null;
  assigned_at: string | null;
  interview_started_at: string | null;
  interview_ended_at: string | null;
  duration_seconds: number | null;
  absent_at: string | null;
  absent_note: string | null;
  interview_note: string | null;
  added_by_id: string | null;
  added_by_name: string | null;
  added_by_email: string | null;
  added_by_role: UserRole | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateDayHistory {
  id: string;
  candidate_id: string | null;
  interview_day: string;
  candidate_code: string;
  student_number: string | null;
  full_name: string;
  phone: string | null;
  department: string | null;
  specialization: import("@/lib/specializations").SpecializationCode | null;
  shift: string;
  status: CandidateStatus;
  absent_note: string | null;
  checked_in_at: string | null;
  absent_at: string | null;
  recorded_at: string;
}

export interface ScheduleRequest {
  id: string;
  candidate_id: string;
  kind: "RESCHEDULE" | "FOLLOWUP_UNDECIDED";
  current_shift: string | null;
  proposed_shift: string | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "RESOLVED";
  requested_by: string | null;
  requested_role: UserRole | null;
  reviewed_by: string | null;
  review_note: string;
  created_at: string;
  reviewed_at: string | null;
}

export interface RubricCriterion {
  id: string;
  name: string;
  description: string | null;
  max_score: number;
  weight: number;
  sort_order: number;
  active: boolean;
}

export interface Evaluation {
  id: string;
  candidate_id: string;
  table_id: string | null;
  interviewer_id: string | null;
  interviewer_name: string | null;
  table_label: string | null;
  scores: Record<string, number>;
  average_score: number | null;
  comment: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  challenge_scores: Record<string, number>;
  challenge_average_score: number | null;
  challenge_comment: string | null;
  challenge_interviewer_id: string | null;
  challenge_interviewer_name: string | null;
  challenge_table_label: string | null;
  challenge_started_at: string | null;
  challenge_ended_at: string | null;
  challenge_duration_seconds: number | null;
  created_at: string;
}

export type ReviewDecisionValue = "PASS" | "FAIL" | "CONSIDER";

export interface ReviewPortal {
  department: import("@/lib/departments").DepartmentCode;
  active: boolean;
  generation: string;
  opened_at: string;
  closed_at: string | null;
}

export interface ReviewDecision {
  id: string;
  candidate_id: string;
  department: import("@/lib/departments").DepartmentCode;
  decision: ReviewDecisionValue;
  note: string;
  portal_generation: string;
  decided_at: string;
  updated_at: string;
}

export interface ReviewDecisionEvent {
  id: string;
  candidate_id: string;
  department: import("@/lib/departments").DepartmentCode;
  decision: ReviewDecisionValue;
  note: string;
  portal_generation: string;
  changed_at: string;
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: "Quản trị (BTC)",
  SUPPORT_IT: "Support IT",
  CHECKIN: "Check-in",
  COORDINATOR: "Điều phối",
  INTERVIEWER: "Giám khảo",
};

export const ROLE_HOME: Record<UserRole, string> = {
  ADMIN: "/admin",
  SUPPORT_IT: "/admin",
  CHECKIN: "/checkin",
  COORDINATOR: "/coordinator",
  INTERVIEWER: "/interviewer",
};

export const STATUS_LABEL: Record<CandidateStatus, string> = {
  NOT_ARRIVED: "Chưa đến",
  CHECKED_IN: "Đã check-in",
  ASSIGNED: "Được phân bàn",
  INTERVIEWING: "Đang phỏng vấn",
  COMPLETED: "Đã hoàn thành",
  ABSENT: "Vắng mặt",
};

/** Tailwind classes cho badge trạng thái (cặp màu nền/chữ đủ tương phản). */
export const STATUS_CLASS: Record<CandidateStatus, string> = {
  NOT_ARRIVED: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  CHECKED_IN: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  ASSIGNED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  INTERVIEWING: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  ABSENT: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};
