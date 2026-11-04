/** Thời lượng dạng mm:ss (phút có thể > 59, ví dụ 75:03). */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const s = Math.floor(totalSeconds);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Bỏ dấu tiếng Việt + lowercase, dùng cho tìm kiếm và nhận diện cột Excel. */
export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Chuẩn hoá SĐT: Excel hay làm rơi số 0 đầu khi ô kiểu Number. */
export function normalizePhone(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\d{9}$/.test(digits)) return "0" + digits;
  return digits || raw;
}

/** Chỉ chấp nhận link http(s) để tránh javascript: URL khi mở CV. */
export function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  if (!err) return "Đã có lỗi xảy ra";
  if (typeof err === "string") return err;
  if (typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return "Đã có lỗi xảy ra";
}
