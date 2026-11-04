// Tạo (hoặc đặt lại) tài khoản ADMIN mặc định.
// Chạy: npm run seed:admin   (đọc biến từ .env.local)
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = (process.env.SEED_ADMIN_EMAIL || "admin@club.local").trim().toLowerCase();
let password = process.env.SEED_ADMIN_PASSWORD || "";

if (!url || !serviceKey) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env.local");
  process.exit(1);
}
if (password && password.length < 8) {
  console.error("SEED_ADMIN_PASSWORD phải có tối thiểu 8 ký tự");
  process.exit(1);
}
const generated = !password;
if (generated) {
  // 18 ký tự base64url ~ 108 bit ngẫu nhiên
  password = randomBytes(14).toString("base64url");
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function findUserByEmail(target) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

try {
  let user = await findUserByEmail(email);
  if (user) {
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    if (error) throw error;
    console.log(`• Tài khoản ${email} đã tồn tại → đã đặt lại mật khẩu.`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: "Chủ tịch CLB" },
    });
    if (error) throw error;
    user = data.user;
    console.log(`• Đã tạo tài khoản ${email}.`);
  }

  const { error: pErr } = await supabase
    .from("profiles")
    .upsert({ id: user.id, email, full_name: "Chủ tịch CLB", role: "ADMIN", table_id: null });
  if (pErr) {
    if (/relation .*profiles.* does not exist/i.test(pErr.message)) {
      throw new Error("Chưa có bảng profiles. Hãy chạy supabase/schema.sql trước.");
    }
    throw pErr;
  }

  console.log("\n================ ĐĂNG NHẬP ADMIN ================");
  console.log(`  Email   : ${email}`);
  console.log(`  Mật khẩu: ${password}`);
  console.log("=================================================");
  if (generated) console.log("Mật khẩu được sinh ngẫu nhiên, chỉ hiển thị một lần. Hãy lưu lại ngay.");
} catch (e) {
  console.error("Lỗi:", e.message || e);
  process.exit(1);
}
