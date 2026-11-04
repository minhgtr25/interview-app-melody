import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Giờ server, dùng để bù lệch đồng hồ thiết bị cho bộ đếm giờ phỏng vấn. */
export function GET() {
  return NextResponse.json({ now: Date.now() }, { headers: { "Cache-Control": "no-store" } });
}
