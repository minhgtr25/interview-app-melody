import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { DepartmentCode } from "@/lib/departments";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALL = LETTERS + DIGITS;

/** Four copy-friendly characters, always including a letter and a digit. */
export function generateReviewCode() {
  const chars = [LETTERS[randomInt(LETTERS.length)], DIGITS[randomInt(DIGITS.length)]];
  while (chars.length < 4) chars.push(ALL[randomInt(ALL.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function hashReviewCode(department: DepartmentCode, generation: string, code: string, secret: string) {
  return createHmac("sha256", secret).update(`review-code:${department}:${generation}:${code.toUpperCase()}`).digest("hex");
}

export type ReviewSession = { department: DepartmentCode; generation: string; expires: number };

export function signReviewSession(session: ReviewSession, secret: string) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`review-session:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyReviewSession(value: string | undefined, secret: string): ReviewSession | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(`review-session:${payload}`).digest("base64url");
  const actual = Buffer.from(signature);
  const correct = Buffer.from(expected);
  if (actual.length !== correct.length || !timingSafeEqual(actual, correct)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReviewSession;
    if (!parsed || !["CM", "VH", "TT", "DE", "HCTC"].includes(parsed.department)
      || typeof parsed.generation !== "string" || typeof parsed.expires !== "number" || parsed.expires <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
