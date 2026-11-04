import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = 1000; // PostgREST mặc định giới hạn 1000 dòng / request

/** Đọc toàn bộ bảng theo từng trang để không bị cắt ở 1000 dòng. */
export async function fetchAll<T>(
  supabase: SupabaseClient,
  table: string,
  orderBy: string = "created_at"
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order(orderBy, { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}
