import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import type { MeetingReport } from "@/lib/analytics/meeting";
import { formatDateTimeJst } from "@/lib/time";
import { PageHeader } from "@/components/common/ui";
import { MeetingView } from "@/components/common/MeetingView";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) notFound();
  const r = await repo.getReport(await getDb(), n);
  if (!r) notFound();
  const report = JSON.parse(r.content) as MeetingReport;
  return (
    <>
      <PageHeader
        title={`${r.period} の経営会議`}
        en="MANAGEMENT MEETING"
        description={`${formatDateTimeJst(r.created_at)} 作成`}
        actions={<Link href="/reports" className="text-sm text-gold hover:underline">← 経営会議へ</Link>}
      />
      <MeetingView report={report} />
    </>
  );
}
