import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEPARTMENTS, isDepartmentCode } from "@/lib/departments";
import { getDepartmentReviewData, getReviewPortal, hasReviewAccess } from "@/lib/reviews/server";
import { ReviewAccessForm } from "./review-access-form";
import { ReviewWorkspace } from "./review-workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function DepartmentReviewPage({ params }: { params: Promise<{ department: string }> }) {
  const { department: value } = await params;
  if (!isDepartmentCode(value)) notFound();
  const department = DEPARTMENTS.find((item) => item.code === value)!;
  const portal = await getReviewPortal(value);
  if (!portal?.active) return <main className="app-page flex items-center justify-center px-4 py-10">
    <div className="app-panel w-full max-w-md border-t-4 border-t-primary p-6 sm:p-8">
      <p className="font-mono text-sm tracking-widest text-muted-foreground">{department.code} / CHỐT KẾT QUẢ</p>
      <h1 className="mt-4 text-3xl font-semibold">Cổng chấm chưa mở</h1>
      <p className="mt-3 text-muted-foreground">Admin sẽ mở link của Ban {department.name} khi bắt đầu chốt kết quả.</p>
    </div>
  </main>;
  if (!await hasReviewAccess(value, portal)) return <ReviewAccessForm department={department} />;
  const data = await getDepartmentReviewData(value);
  return <ReviewWorkspace department={department} initialRows={data.rows} criteria={data.criteria} />;
}
