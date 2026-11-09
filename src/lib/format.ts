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
  return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
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
    timeZone: "Asia/Ho_Chi_Minh",
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
  if (!err) return "Đã có lỗi xảy ra. Vui lòng thử lại.";
  if (typeof err === "string") return userFacingError(err);
  if (typeof err === "object") {
    const value = err as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof value.code === "string" ? value.code : "";
    const message = typeof value.message === "string" ? value.message : "";
    // Keep the precise Vietnamese rule message returned by an application RPC.
    if (/[À-ỹ]/i.test(message)) return message;
    const mapped: Record<string, string> = {
      PGRST202: "Tính năng này chưa được cập nhật trên máy chủ. Hãy báo Admin kiểm tra cấu hình hệ thống.",
      42883: "Tính năng này chưa được cập nhật trên máy chủ. Hãy báo Admin kiểm tra cấu hình hệ thống.",
      42703: "Dữ liệu chưa được cập nhật trên máy chủ. Hãy báo Admin kiểm tra cấu hình hệ thống.",
      42501: "Tài khoản hiện tại không có quyền thực hiện thao tác này.",
      23505: "Thông tin này đã tồn tại. Hãy kiểm tra mã, email hoặc tài khoản bị trùng.",
      23503: "Không thể thực hiện vì dữ liệu đang được liên kết với mục khác.",
      23514: "Thông tin chưa đúng quy tắc. Hãy kiểm tra lại các trường vừa nhập.",
      "22P02": "Định dạng dữ liệu chưa hợp lệ. Hãy kiểm tra lại thông tin vừa nhập.",
      PGRST116: "Không tìm thấy dữ liệu hoặc mục này đã được thay đổi ở thiết bị khác.",
      "40001": "Dữ liệu vừa được người khác cập nhật. Hãy tải lại danh sách rồi thử lại.",
      "40P01": "Hệ thống đang xử lý đồng thời. Vui lòng thử lại sau ít giây.",
    };
    if (mapped[code]) return mapped[code];
    if (/failed to fetch|network request failed|fetch failed|load failed/i.test(message)) {
      return "Mất kết nối máy chủ. Kiểm tra mạng rồi thử lại.";
    }
    return userFacingError(message);
  }
  return "Đã có lỗi xảy ra. Vui lòng thử lại.";
}

function userFacingError(message: string): string {
  const value = message.trim();
  if (!value) return "Đã có lỗi xảy ra. Vui lòng thử lại.";
  // Preserve actionable business-rule messages raised by the application.
  if (/[À-ỹ]/i.test(value)) return value;
  if (/failed to fetch|network request failed|fetch failed|load failed/i.test(value)) {
    return "Mất kết nối máy chủ. Kiểm tra mạng rồi thử lại.";
  }
  if (/invalid login credentials|invalid email or password/i.test(value)) return "Email hoặc mật khẩu chưa đúng.";
  if (/already registered|user already exists|email.*already exists/i.test(value)) return "Email này đã được cấp tài khoản.";
  if (/password.*(short|weak|at least)|password should be/i.test(value)) return "Mật khẩu chưa đạt yêu cầu. Hãy kiểm tra độ dài và ký tự.";
  if (/rate limit|too many requests/i.test(value)) return "Bạn thao tác quá nhanh. Vui lòng chờ một chút rồi thử lại.";
  if (/schema cache|could not find the function|function .* does not exist|column .* does not exist|violates .* constraint|duplicate key value|permission denied|row-level security|jwt|postgrest|postgres|supabase/i.test(value)) {
    return "Hệ thống chưa sẵn sàng cho thao tác này. Hãy báo Admin kiểm tra cấu hình.";
  }
  return "Không thể hoàn tất thao tác. Hãy thử lại; nếu lỗi vẫn còn, báo Admin kiểm tra.";
}
