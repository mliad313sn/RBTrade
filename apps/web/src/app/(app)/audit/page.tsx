import { AuditLog } from '@/components/AuditLog';

export const metadata = { title: 'Audit log' };

export default function AuditPage() {
  return (
    <>
      <h1 className="k-sr-only">Audit log</h1>
      <AuditLog />
    </>
  );
}
